import prisma from './prisma';
import { RecommendationType, RecommendationSeverity, RecommendationStatus, AlertSeverity } from '@prisma/client';

export interface HealthScoreBreakdown {
  totalScore: number; // 0 - 100
  utilizationScore: number; // max 35
  costEfficiencyScore: number; // max 25
  renewalRiskScore: number; // max 20
  unusedLicensesScore: number; // max 10
  overlapRiskScore: number; // max 10
  status: 'EXCELLENT' | 'HEALTHY' | 'MODERATE' | 'AT_RISK';
}

export async function calculateLicenseHealthScore(): Promise<HealthScoreBreakdown> {
  const [softwareList, renewals] = await Promise.all([
    prisma.software.findMany({
      include: {
        licenses: {
          include: {
            assignments: { where: { status: 'ACTIVE' } },
          },
        },
      },
    }),
    prisma.renewal.findMany({
      where: {
        status: { in: ['UPCOMING', 'DUE_7_DAYS', 'DUE_30_DAYS', 'EXPIRED'] },
      },
    }),
  ]);

  let totalLicenses = 0;
  let activeLicenses = 0;
  let totalCost = 0;
  let wastedCost = 0;

  for (const sw of softwareList) {
    for (const lic of sw.licenses) {
      const freq = lic.billingFrequency || 'MONTHLY';
      const unused = Math.max(0, lic.totalQuantity - lic.assignments.length);
      let licAnnualCost = 0;
      let licAnnualWasted = 0;

      if (freq === 'ANNUAL') {
        licAnnualCost = lic.totalQuantity * lic.costPerLicense;
        licAnnualWasted = unused * lic.costPerLicense;
      } else if (freq === 'MONTHLY') {
        licAnnualCost = lic.totalQuantity * lic.costPerLicense * 12;
        licAnnualWasted = unused * lic.costPerLicense * 12;
      } else {
        licAnnualCost = lic.totalQuantity * lic.costPerLicense;
        licAnnualWasted = 0;
      }

      totalLicenses += lic.totalQuantity;
      activeLicenses += lic.assignments.length;
      totalCost += licAnnualCost;
      wastedCost += licAnnualWasted;
    }
  }

  // 1. Utilization Score (0 to 35 points)
  const utilRate = totalLicenses > 0 ? (activeLicenses / totalLicenses) : 1;
  const utilizationScore = Math.round(utilRate * 35);

  // 2. Cost Efficiency Score (0 to 25 points)
  const efficiencyRate = totalCost > 0 ? ((totalCost - wastedCost) / totalCost) : 1;
  const costEfficiencyScore = Math.round(efficiencyRate * 25);

  // 3. Renewal Risk Score (0 to 20 points)
  let renewalDeductions = 0;
  for (const r of renewals) {
    if (r.status === 'EXPIRED') renewalDeductions += 6;
    else if (r.status === 'DUE_7_DAYS') renewalDeductions += 4;
    else if (r.status === 'DUE_30_DAYS') renewalDeductions += 2;
  }
  const renewalRiskScore = Math.max(0, 20 - renewalDeductions);

  // 4. Unused Licenses Minimization (0 to 10 points)
  const unusedRatio = totalLicenses > 0 ? (totalLicenses - activeLicenses) / totalLicenses : 0;
  const unusedLicensesScore = Math.round(Math.max(0, (1 - unusedRatio * 2) * 10));

  // 5. Overlap Risk Score (0 to 10 points)
  const categories = softwareList.map(s => s.category);
  const duplicates = categories.filter((c, index) => categories.indexOf(c) !== index);
  const overlapRiskScore = Math.max(0, 10 - duplicates.length * 2);

  const totalScore = Math.min(100, Math.max(0, 
    utilizationScore + costEfficiencyScore + renewalRiskScore + unusedLicensesScore + overlapRiskScore
  ));

  let status: 'EXCELLENT' | 'HEALTHY' | 'MODERATE' | 'AT_RISK' = 'HEALTHY';
  if (totalScore >= 85) status = 'EXCELLENT';
  else if (totalScore >= 70) status = 'HEALTHY';
  else if (totalScore >= 50) status = 'MODERATE';
  else status = 'AT_RISK';

  return {
    totalScore,
    utilizationScore,
    costEfficiencyScore,
    renewalRiskScore,
    unusedLicensesScore,
    overlapRiskScore,
    status,
  };
}

export async function evaluateAndGenerateRecommendations() {
  const [softwareList, pendingRequests, renewals] = await Promise.all([
    prisma.software.findMany({
      include: {
        vendor: true,
        licenses: {
          include: {
            assignments: { where: { status: 'ACTIVE' } },
          },
        },
      },
    }),
    prisma.softwareRequest.findMany({
      where: { status: 'PENDING' },
      include: { software: { include: { licenses: { include: { assignments: { where: { status: 'ACTIVE' } } } } } }, user: true },
    }),
    prisma.renewal.findMany({
      include: { software: { include: { licenses: { include: { assignments: { where: { status: 'ACTIVE' } } } } } } },
    }),
  ]);

  const newRecommendations: any[] = [];
  const today = new Date();

  // RULE 1: Unused licenses & low utilization (< 70%)
  for (const sw of softwareList) {
    for (const lic of sw.licenses) {
      const activeCount = lic.assignments.length;
      const unusedCount = Math.max(0, lic.totalQuantity - activeCount);
      const utilRate = lic.totalQuantity > 0 ? (activeCount / lic.totalQuantity) * 100 : 0;
      const freq = lic.billingFrequency || 'MONTHLY';

      let licAnnualSaving = 0;
      let licMonthlySaving = 0;
      if (freq === 'ANNUAL') {
        licAnnualSaving = unusedCount * lic.costPerLicense;
        licMonthlySaving = licAnnualSaving / 12;
      } else if (freq === 'MONTHLY') {
        licMonthlySaving = unusedCount * lic.costPerLicense;
        licAnnualSaving = licMonthlySaving * 12;
      }

      if (utilRate < 70 && unusedCount > 0) {
        newRecommendations.push({
          softwareId: sw.id,
          licenseId: lic.id,
          type: RecommendationType.REALLOCATE_UNUSED,
          severity: utilRate < 40 ? RecommendationSeverity.CRITICAL : RecommendationSeverity.WARNING,
          title: `Reallocate or Reduce Unused ${sw.name} Licenses`,
          reason: `${unusedCount} of ${lic.totalQuantity} licenses are currently unassigned (${utilRate.toFixed(1)}% utilization).`,
          supportingMetrics: {
            totalLicenses: lic.totalQuantity,
            activeLicenses: activeCount,
            unusedLicenses: unusedCount,
            utilizationRate: Number(utilRate.toFixed(1)),
            costPerLicense: lic.costPerLicense,
            billingFrequency: freq,
          },
          estimatedMonthlySavings: Math.round(licMonthlySaving),
          estimatedAnnualSavings: Math.round(licAnnualSaving),
          suggestedAction: `Review ${unusedCount} idle seats to reassign to incoming personnel or negotiate reduced seat count on next invoice.`,
          status: RecommendationStatus.NEW,
        });
      }

      // RULE 4: High cost & low utilization
      const totalMonthlySpend = freq === 'ANNUAL' ? (lic.totalQuantity * lic.costPerLicense) / 12 : lic.totalQuantity * lic.costPerLicense;
      if (totalMonthlySpend >= 30000 && utilRate < 60) {
        newRecommendations.push({
          softwareId: sw.id,
          licenseId: lic.id,
          type: RecommendationType.COST_OPTIMIZATION,
          severity: RecommendationSeverity.CRITICAL,
          title: `High-Spend Optimization: ${sw.name}`,
          reason: `High monthly expenditure (₹${Math.round(totalMonthlySpend).toLocaleString('en-IN')}) paired with low utilization (${utilRate.toFixed(1)}%).`,
          supportingMetrics: {
            totalMonthlySpend: Math.round(totalMonthlySpend),
            totalAnnualSpend: Math.round(totalMonthlySpend * 12),
            costPerLicense: lic.costPerLicense,
            billingFrequency: freq,
            utilizationRate: Number(utilRate.toFixed(1)),
            potentialMonthlySaving: Math.round(licMonthlySaving),
            potentialAnnualSaving: Math.round(licAnnualSaving),
          },
          estimatedMonthlySavings: Math.round(licMonthlySaving),
          estimatedAnnualSavings: Math.round(licAnnualSaving),
          suggestedAction: `Initiate priority procurement audit to rightsize tiered subscription.`,
          status: RecommendationStatus.NEW,
        });
      }
    }
  }

  // RULE 2: Existing unused license available when employee requests software
  for (const req of pendingRequests) {
    let availableCount = 0;
    let targetLic = req.software.licenses[0];
    for (const lic of req.software.licenses) {
      const active = lic.assignments.length;
      const avail = Math.max(0, lic.totalQuantity - active);
      if (avail > 0 && !targetLic) targetLic = lic;
      availableCount += avail;
    }

    if (availableCount > 0) {
      const freq = targetLic?.billingFrequency || 'MONTHLY';
      const costPerLic = targetLic?.costPerLicense || 0;
      let estAnnual = 0;
      let estMonthly = 0;
      if (freq === 'ANNUAL') {
        estAnnual = costPerLic;
        estMonthly = costPerLic / 12;
      } else {
        estMonthly = costPerLic;
        estAnnual = costPerLic * 12;
      }

      newRecommendations.push({
        softwareId: req.softwareId,
        type: RecommendationType.USE_EXISTING_LICENSE,
        severity: RecommendationSeverity.INFO,
        title: `Assign Existing Unused License for ${req.software.name}`,
        reason: `${req.user.name} requested ${req.software.name}. The system detected ${availableCount} unused licenses available in the pool.`,
        supportingMetrics: {
          requestId: req.id,
          userName: req.user.name,
          availableSeats: availableCount,
          costPerLicense: costPerLic,
          billingFrequency: freq,
        },
        estimatedMonthlySavings: Math.round(estMonthly),
        estimatedAnnualSavings: Math.round(estAnnual),
        suggestedAction: `Fulfill request by allocating an existing unassigned license instead of purchasing a new seat.`,
        status: RecommendationStatus.NEW,
      });
    }
  }

  // RULE 3: Approaching renewal (< 30 days) with low utilization (< 70%)
  for (const ren of renewals) {
    const daysUntilRenewal = Math.ceil((new Date(ren.renewalDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntilRenewal >= 0 && daysUntilRenewal <= 30) {
      let totalQty = 0;
      let activeQty = 0;
      let renewalUnusedAnnual = 0;
      let renewalUnusedMonthly = 0;

      for (const lic of ren.software.licenses) {
        totalQty += lic.totalQuantity;
        activeQty += lic.assignments.length;
        const unassigned = Math.max(0, lic.totalQuantity - lic.assignments.length);
        const freq = lic.billingFrequency || 'MONTHLY';
        if (freq === 'ANNUAL') {
          renewalUnusedAnnual += unassigned * lic.costPerLicense;
          renewalUnusedMonthly += (unassigned * lic.costPerLicense) / 12;
        } else {
          renewalUnusedMonthly += unassigned * lic.costPerLicense;
          renewalUnusedAnnual += unassigned * lic.costPerLicense * 12;
        }
      }
      const util = totalQty > 0 ? (activeQty / totalQty) * 100 : 0;
      if (util < 70) {
        newRecommendations.push({
          softwareId: ren.softwareId,
          type: RecommendationType.PRE_RENEWAL_REVIEW,
          severity: daysUntilRenewal <= 7 ? RecommendationSeverity.CRITICAL : RecommendationSeverity.WARNING,
          title: `Pre-Renewal Contract Review: ${ren.software.name}`,
          reason: `Renewal due in ${daysUntilRenewal} days with only ${util.toFixed(1)}% seat utilization.`,
          supportingMetrics: {
            renewalDate: ren.renewalDate,
            daysUntilRenewal,
            utilizationRate: Number(util.toFixed(1)),
          },
          estimatedMonthlySavings: Math.round(renewalUnusedMonthly),
          estimatedAnnualSavings: Math.round(renewalUnusedAnnual),
          suggestedAction: `Do not auto-renew at current seat capacity. Adjust contract volume prior to deadline.`,
          status: RecommendationStatus.NEW,
        });
      }
    }
  }

  // RULE 5: Duplicate Category / Overlapping software (Data-driven: secondary tool spend)
  const categoryMap = new Map<string, typeof softwareList>();
  for (const sw of softwareList) {
    const list = categoryMap.get(sw.category) || [];
    list.push(sw);
    categoryMap.set(sw.category, list);
  }

  categoryMap.forEach((tools, category) => {
    if (tools.length > 1) {
      const toolNames = tools.map(t => t.name).join(' & ');
      let secondaryAnnualSpend = 0;
      for (let i = 1; i < tools.length; i++) {
        for (const lic of tools[i].licenses) {
          const freq = lic.billingFrequency || 'MONTHLY';
          if (freq === 'ANNUAL') {
            secondaryAnnualSpend += lic.totalQuantity * lic.costPerLicense;
          } else if (freq === 'MONTHLY') {
            secondaryAnnualSpend += lic.totalQuantity * lic.costPerLicense * 12;
          }
        }
      }

      newRecommendations.push({
        softwareId: tools[0].id,
        type: RecommendationType.DUPLICATE_CONSOLIDATION,
        severity: RecommendationSeverity.INFO,
        title: `Consolidate Overlapping ${category} Tools`,
        reason: `Multiple concurrent tools active under ${category}: ${toolNames}.`,
        supportingMetrics: {
          category,
          tools: tools.map(t => ({ name: t.name, vendor: t.vendor?.name })),
        },
        estimatedMonthlySavings: Math.round(secondaryAnnualSpend / 12),
        estimatedAnnualSavings: Math.round(secondaryAnnualSpend),
        suggestedAction: `Evaluate standardization on a single preferred platform across departments to leverage volume tier pricing.`,
        status: RecommendationStatus.NEW,
      });
    }
  });

  return newRecommendations;
}
