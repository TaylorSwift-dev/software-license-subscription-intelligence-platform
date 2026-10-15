import prisma from './prisma';

export interface SoftwareUtilization {
  softwareId: string;
  softwareName: string;
  category: string;
  vendorName: string;
  totalLicenses: number;
  activeLicenses: number;
  availableLicenses: number;
  unusedLicenses: number;
  utilizationRate: number; // 0 to 100
  classification: 'EXCELLENT' | 'GOOD' | 'MODERATE' | 'LOW' | 'CRITICAL';
  costPerLicense: number;
  billingFrequency: string;
  monthlyCost: number;
  annualCost: number;
  oneTimeCost: number;
  unusedMonthlyCost: number;
  potentialAnnualSaving: number;
  assignedUsers?: { id: string; name: string; email: string; initials: string }[];
}

export interface DepartmentSpend {
  departmentId: string;
  departmentName: string;
  departmentCode: string;
  monthlyBudget: number;
  actualMonthlySpend: number;
  actualAnnualSpend: number;
  activeLicenseCount: number;
  budgetUtilizationRate: number;
}

export interface PlatformAnalyticsSummary {
  totalSoftware: number;
  totalVendors: number;
  totalLicenses: number;
  activeLicenses: number;
  availableLicenses: number;
  overallUtilization: number;
  monthlyExpenditure: number;
  annualExpenditure: number;
  potentialMonthlySavings: number;
  potentialAnnualSavings: number;
  oneTimeExpenditure: number;
  // Dashboard backward-compatibility aliases
  totalMonthlyCost: number;
  totalAnnualCost: number;
  unusedMonthlyCost: number;
  unusedAnnualCost: number;
  underutilizedCount: number;
  softwareBreakdown: SoftwareUtilization[];
  departmentBreakdown: DepartmentSpend[];
}

export function classifyUtilization(rate: number): 'EXCELLENT' | 'GOOD' | 'MODERATE' | 'LOW' | 'CRITICAL' {
  if (rate >= 90) return 'EXCELLENT';
  if (rate >= 75) return 'GOOD';
  if (rate >= 50) return 'MODERATE';
  if (rate >= 25) return 'LOW';
  return 'CRITICAL';
}

export async function calculatePlatformAnalytics(): Promise<PlatformAnalyticsSummary> {
  const [softwareList, vendorsCount, departments] = await Promise.all([
    prisma.software.findMany({
      include: {
        vendor: true,
        licenses: {
          include: {
            assignments: {
              where: { status: 'ACTIVE' },
              include: { user: true, department: true },
            },
          },
        },
      },
    }),
    prisma.vendor.count(),
    prisma.department.findMany({
      include: {
        assignments: {
          where: { status: 'ACTIVE' },
          include: { license: true },
        },
      },
    }),
  ]);

  let totalLicenses = 0;
  let totalActiveLicenses = 0;
  let totalMonthlyExpenditure = 0;
  let totalAnnualExpenditure = 0;
  let totalPotentialMonthlySavings = 0;
  let totalPotentialAnnualSavings = 0;
  let totalOneTimeExpenditure = 0;
  let underutilizedCount = 0;

  const softwareBreakdown: SoftwareUtilization[] = [];

  for (const sw of softwareList) {
    let swTotal = 0;
    let swActive = 0;
    let swMonthlyCost = 0;
    let swAnnualCost = 0;
    let swOneTimeCost = 0;
    let swUnusedMonthlyCost = 0;
    let swUnusedAnnualCost = 0;
    let avgCostPerLicense = 0;
    let primaryBillingFreq = 'MONTHLY';
    const assignedUsersMap = new Map<string, { id: string; name: string; email: string; initials: string }>();

    for (const lic of sw.licenses) {
      const licTotal = lic.totalQuantity;
      const licActive = lic.assignments.length;
      const licCost = lic.costPerLicense;
      const isToken = lic.consumptionType === 'TOKEN_BASED';
      const freq = lic.billingFrequency || 'MONTHLY';
      primaryBillingFreq = freq;

      for (const assign of lic.assignments) {
        if (assign.user && !assignedUsersMap.has(assign.user.id)) {
          const names = assign.user.name.trim().split(/\s+/);
          const initials = names.length >= 2
            ? `${names[0][0]}${names[names.length - 1][0]}`.toUpperCase()
            : assign.user.name.slice(0, 2).toUpperCase();
          assignedUsersMap.set(assign.user.id, {
            id: assign.user.id,
            name: assign.user.name,
            email: assign.user.email,
            initials,
          });
        }
      }

      swTotal += licTotal;
      swActive += licActive;
      avgCostPerLicense = licCost;
      const unusedCount = Math.max(0, licTotal - licActive);

      let licAnnual = 0;
      let licMonthly = 0;
      let licUnusedAnnual = 0;
      let licUnusedMonthly = 0;

      if (isToken && (lic.allocatedTokens || 0) > 0 && (lic.tokenUnitCost || 0) > 0) {
        const poolCost = (lic.allocatedTokens || 0) * (lic.tokenUnitCost || 0);
        const remainingTokens = Math.max(0, (lic.allocatedTokens || 0) - (lic.usedTokens || 0));
        const remainingCost = remainingTokens * (lic.tokenUnitCost || 0);

        if (freq === 'ANNUAL') {
          licAnnual = poolCost;
          licMonthly = poolCost / 12;
          licUnusedAnnual = remainingCost;
          licUnusedMonthly = remainingCost / 12;
        } else {
          licMonthly = poolCost;
          licAnnual = poolCost * 12;
          licUnusedMonthly = remainingCost;
          licUnusedAnnual = remainingCost * 12;
        }
      } else if (freq === 'ANNUAL') {
        licAnnual = licTotal * licCost;
        licMonthly = (licTotal * licCost) / 12;
        licUnusedAnnual = unusedCount * licCost;
        licUnusedMonthly = (unusedCount * licCost) / 12;
      } else if (freq === 'MONTHLY') {
        licMonthly = licTotal * licCost;
        licAnnual = licTotal * licCost * 12;
        licUnusedMonthly = unusedCount * licCost;
        licUnusedAnnual = unusedCount * licCost * 12;
      } else if (freq === 'ONE_TIME') {
        swOneTimeCost += licTotal * licCost;
        licAnnual = 0;
        licMonthly = 0;
        licUnusedAnnual = 0;
        licUnusedMonthly = 0;
      }

      swMonthlyCost += licMonthly;
      swAnnualCost += licAnnual;
      swUnusedMonthlyCost += licUnusedMonthly;
      swUnusedAnnualCost += licUnusedAnnual;
    }

    const swAvailable = Math.max(0, swTotal - swActive);
    const swUnused = swAvailable;
    const utilizationRate = swTotal > 0 ? Number(((swActive / swTotal) * 100).toFixed(1)) : 0;
    const classification = classifyUtilization(utilizationRate);

    if (utilizationRate < 70 && swTotal > 0) {
      underutilizedCount++;
    }

    totalLicenses += swTotal;
    totalActiveLicenses += swActive;
    totalMonthlyExpenditure += swMonthlyCost;
    totalAnnualExpenditure += swAnnualCost;
    totalPotentialMonthlySavings += swUnusedMonthlyCost;
    totalPotentialAnnualSavings += swUnusedAnnualCost;
    totalOneTimeExpenditure += swOneTimeCost;

    softwareBreakdown.push({
      softwareId: sw.id,
      softwareName: sw.name,
      category: sw.category,
      vendorName: sw.vendor?.name || 'N/A',
      totalLicenses: swTotal,
      activeLicenses: swActive,
      availableLicenses: swAvailable,
      unusedLicenses: swUnused,
      utilizationRate,
      classification,
      costPerLicense: avgCostPerLicense,
      billingFrequency: primaryBillingFreq,
      monthlyCost: Math.round(swMonthlyCost),
      annualCost: Math.round(swAnnualCost),
      oneTimeCost: Math.round(swOneTimeCost),
      unusedMonthlyCost: Math.round(swUnusedMonthlyCost),
      potentialAnnualSaving: Math.round(swUnusedAnnualCost),
      assignedUsers: Array.from(assignedUsersMap.values()),
    });
  }

  const overallUtilization = totalLicenses > 0 
    ? Number(((totalActiveLicenses / totalLicenses) * 100).toFixed(1)) 
    : 0;

  const departmentBreakdown: DepartmentSpend[] = departments.map((dept) => {
    let deptMonthlySpend = 0;
    let deptAnnualSpend = 0;
    for (const assign of dept.assignments) {
      const lic = assign.license;
      const freq = lic.billingFrequency || 'MONTHLY';
      if (freq === 'ANNUAL') {
        deptAnnualSpend += lic.costPerLicense;
        deptMonthlySpend += lic.costPerLicense / 12;
      } else if (freq === 'MONTHLY') {
        deptMonthlySpend += lic.costPerLicense;
        deptAnnualSpend += lic.costPerLicense * 12;
      }
    }
    const budgetUtilization = dept.budgetMonthly > 0 
      ? Number(((deptMonthlySpend / dept.budgetMonthly) * 100).toFixed(1)) 
      : 0;

    return {
      departmentId: dept.id,
      departmentName: dept.name,
      departmentCode: dept.code,
      monthlyBudget: dept.budgetMonthly,
      actualMonthlySpend: Math.round(deptMonthlySpend),
      actualAnnualSpend: Math.round(deptAnnualSpend),
      activeLicenseCount: dept.assignments.length,
      budgetUtilizationRate: budgetUtilization,
    };
  });

  return {
    totalSoftware: softwareList.length,
    totalVendors: vendorsCount,
    totalLicenses,
    activeLicenses: totalActiveLicenses,
    availableLicenses: Math.max(0, totalLicenses - totalActiveLicenses),
    overallUtilization,
    monthlyExpenditure: Math.round(totalMonthlyExpenditure),
    annualExpenditure: Math.round(totalAnnualExpenditure),
    potentialMonthlySavings: Math.round(totalPotentialMonthlySavings),
    potentialAnnualSavings: Math.round(totalPotentialAnnualSavings),
    oneTimeExpenditure: Math.round(totalOneTimeExpenditure),
    totalMonthlyCost: Math.round(totalMonthlyExpenditure),
    totalAnnualCost: Math.round(totalAnnualExpenditure),
    unusedMonthlyCost: Math.round(totalPotentialMonthlySavings),
    unusedAnnualCost: Math.round(totalPotentialAnnualSavings),
    underutilizedCount,
    softwareBreakdown,
    departmentBreakdown,
  };
}
