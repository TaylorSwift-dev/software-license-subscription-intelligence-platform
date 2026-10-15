import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import prisma from '@/lib/prisma';

export interface YearlyRecoveryMetric {
  year: number;
  totalInvestment: number;
  realizedValue: number;
  unrecoveredCost: number;
  recoveryPercentage: number;
  unrecoveredPercentage: number;
  recordsCount: number;
}

export async function GET(req: NextRequest) {
  const { user, errorResponse } = requireAuth(req);
  if (errorResponse) return errorResponse;

  try {
    const costRecords = await prisma.costRecord.findMany({
      include: {
        software: true,
        department: true,
      },
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
    });

    if (costRecords.length === 0) {
      return NextResponse.json({
        success: true,
        years: [],
        message: 'No recovery data available yet.',
      });
    }

    // Group cost records by year
    const yearMap = new Map<number, {
      investment: number;
      realizedValue: number;
      recordsCount: number;
    }>();

    // Group cost records by month key (e.g. "2026-10" or year, month)
    const monthMap = new Map<string, {
      year: number;
      month: number;
      label: string;
      spending: number;
      realizedValue: number;
      wastedCost: number;
      recordsCount: number;
    }>();

    const monthNamesShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    for (const record of costRecords) {
      const yr = record.year;
      const mo = record.month;
      const mKey = `${yr}-${String(mo).padStart(2, '0')}`;

      // Derive investment: explicit investment field or allocatedCost + wastedCost
      const recordInvestment = (record.investment && record.investment > 0)
        ? record.investment
        : (record.allocatedCost + record.wastedCost);

      // Derive realized value: explicit realizedValue field or allocatedCost
      const recordRealized = (record.realizedValue && record.realizedValue > 0)
        ? record.realizedValue
        : record.allocatedCost;

      const recordWasted = record.wastedCost || Math.max(0, recordInvestment - recordRealized);

      const current = yearMap.get(yr) || { investment: 0, realizedValue: 0, recordsCount: 0 };
      current.investment += recordInvestment;
      current.realizedValue += recordRealized;
      current.recordsCount += 1;
      yearMap.set(yr, current);

      const mCurrent = monthMap.get(mKey) || {
        year: yr,
        month: mo,
        label: `${monthNamesShort[mo - 1] || 'M' + mo} ${yr}`,
        spending: 0,
        realizedValue: 0,
        wastedCost: 0,
        recordsCount: 0,
      };
      mCurrent.spending += recordInvestment;
      mCurrent.realizedValue += recordRealized;
      mCurrent.wastedCost += recordWasted;
      mCurrent.recordsCount += 1;
      monthMap.set(mKey, mCurrent);
    }

    const sortedMonthKeys = Array.from(monthMap.keys()).sort();
    const monthlySpendingAndSavings = sortedMonthKeys.map((key) => {
      const m = monthMap.get(key)!;
      const spending = Math.round(m.spending);
      const realizedSavings = Math.round(m.realizedValue);
      const wastedCost = Math.round(m.wastedCost);
      const savingsRate = spending > 0 ? Number(((realizedSavings / spending) * 100).toFixed(1)) : 0;
      return {
        key,
        year: m.year,
        month: m.month,
        label: m.label,
        spending,
        realizedSavings,
        savings: realizedSavings, // Alias for chart series
        potentialSavings: wastedCost,
        wastedCost,
        savingsRate,
        recordsCount: m.recordsCount,
      };
    });

    const sortedYears = Array.from(yearMap.keys()).sort((a, b) => a - b);

    const yearlyMetrics: YearlyRecoveryMetric[] = sortedYears.map((year) => {
      const data = yearMap.get(year)!;
      const investment = Math.round(data.investment);
      const realized = Math.round(data.realizedValue);
      const unrecovered = Math.max(0, investment - realized);

      const recoveryPercentage = investment > 0
        ? Number(((realized / investment) * 100).toFixed(1))
        : 0;

      const unrecoveredPercentage = investment > 0
        ? Number(((unrecovered / investment) * 100).toFixed(1))
        : 0;

      return {
        year,
        totalCost: investment,
        utilizedCost: realized,
        unutilizedCost: unrecovered,
        recoveryRate: recoveryPercentage,
        totalInvestment: investment,
        realizedValue: realized,
        unrecoveredCost: unrecovered,
        recoveryPercentage,
        unrecoveredPercentage,
        recordsCount: data.recordsCount,
      };
    });

    // Calculate Year-over-Year (YoY) improvements
    let yoyImprovement = null;
    if (yearlyMetrics.length >= 2) {
      const baseline = yearlyMetrics[0]; // Earliest tracked year
      const latest = yearlyMetrics[yearlyMetrics.length - 1]; // Latest year

      const prevYear = yearlyMetrics[yearlyMetrics.length - 2]; // Immediate previous year

      yoyImprovement = {
        baselineYear: baseline.year,
        latestYear: latest.year,
        totalRecoveryPointsImprovement: Number((latest.recoveryPercentage - baseline.recoveryPercentage).toFixed(1)),
        oneYearRecoveryPointsImprovement: Number((latest.recoveryPercentage - prevYear.recoveryPercentage).toFixed(1)),
        investmentChange: latest.totalInvestment - baseline.totalInvestment,
        investmentChangePercentage: baseline.totalInvestment > 0
          ? Number((((latest.totalInvestment - baseline.totalInvestment) / baseline.totalInvestment) * 100).toFixed(1))
          : 0,
        realizedValueChange: latest.realizedValue - baseline.realizedValue,
        realizedValueChangePercentage: baseline.realizedValue > 0
          ? Number((((latest.realizedValue - baseline.realizedValue) / baseline.realizedValue) * 100).toFixed(1))
          : 0,
        unrecoveredCostChange: latest.unrecoveredCost - baseline.unrecoveredCost,
        unrecoveredCostReductionPercentage: baseline.unrecoveredCost > 0
          ? Number((((baseline.unrecoveredCost - latest.unrecoveredCost) / baseline.unrecoveredCost) * 100).toFixed(1))
          : 0,
      };
    }

    // Group software records and department records by year
    const softwareByYear: Record<number, Array<{
      softwareId: string;
      softwareName: string;
      category: string;
      investment: number;
      realizedValue: number;
      unrecoveredCost: number;
      recoveryRate: number;
      month: number;
    }>> = {};

    const departmentByYear: Record<number, Record<string, {
      departmentId: string;
      departmentName: string;
      departmentCode: string;
      totalSpend: number;
      recordsCount: number;
    }>> = {};

    for (const record of costRecords) {
      const yr = record.year;
      if (!softwareByYear[yr]) softwareByYear[yr] = [];
      if (!departmentByYear[yr]) departmentByYear[yr] = {};

      const recordInvestment = (record.investment && record.investment > 0)
        ? record.investment
        : (record.allocatedCost + record.wastedCost);

      const recordRealized = (record.realizedValue && record.realizedValue > 0)
        ? record.realizedValue
        : record.allocatedCost;

      const recordUnrecovered = Math.max(0, recordInvestment - recordRealized);
      const recordRate = recordInvestment > 0 ? Number(((recordRealized / recordInvestment) * 100).toFixed(1)) : 0;

      softwareByYear[yr].push({
        softwareId: record.softwareId,
        softwareName: record.software?.name || 'Unknown',
        category: record.software?.category || 'General',
        investment: Math.round(recordInvestment),
        realizedValue: Math.round(recordRealized),
        unrecoveredCost: Math.round(recordUnrecovered),
        recoveryRate: recordRate,
        month: record.month,
      });

      if (record.department) {
        const dId = record.department.id;
        if (!departmentByYear[yr][dId]) {
          departmentByYear[yr][dId] = {
            departmentId: dId,
            departmentName: record.department.name,
            departmentCode: record.department.code,
            totalSpend: 0,
            recordsCount: 0,
          };
        }
        departmentByYear[yr][dId].totalSpend += recordInvestment;
        departmentByYear[yr][dId].recordsCount += 1;
      }
    }

    // Check for audit logs / optimization events to compute verified realized savings
    // Look for verified optimization events in audit logs
    const optimizationAuditLogs = await prisma.auditLog.findMany({
      where: {
        action: {
          in: ['UPDATE_RENEWAL', 'REVOKE_LICENSE', 'DELETE', 'APPROVE_REQUEST', 'GENERATE_RECOMMENDATION'],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    // Check recommendations with status ACCEPTED or COMPLETED to calculate confirmed accepted optimization value
    const acceptedRecommendations = await prisma.recommendation.findMany({
      where: {
        status: { in: ['ACCEPTED', 'COMPLETED'] },
      },
      include: { software: true },
    });

    let verifiedRealizedAnnualSavings = 0;
    for (const rec of acceptedRecommendations) {
      verifiedRealizedAnnualSavings += rec.estimatedAnnualSavings || (rec.estimatedMonthlySavings * 12) || 0;
    }

    // Potential savings from current active recommendations
    const activeRecommendations = await prisma.recommendation.findMany({
      where: {
        status: { in: ['NEW', 'REVIEWED'] },
      },
      include: { software: true },
    });

    let potentialUnrealizedAnnualSavings = 0;
    for (const rec of activeRecommendations) {
      potentialUnrealizedAnnualSavings += rec.estimatedAnnualSavings || (rec.estimatedMonthlySavings * 12) || 0;
    }

    const latestRawYear = yearlyMetrics[yearlyMetrics.length - 1]?.year ?? 2026;

    // Enrich yearlyMetrics with savings intelligence, before-and-after optimization analysis, and data completeness
    const enrichedYearlyMetrics = yearlyMetrics.map((ym) => {
      // Historical actual expenditure is ym.totalInvestment
      // Verified realized savings: for latest tracked year, compute from accepted optimizations; for earlier years, flag if no historical optimization log exists
      const hasOptimizationLogs = ym.year === latestRawYear;
      const yearRealizedSavings = hasOptimizationLogs ? Math.round(verifiedRealizedAnnualSavings) : 0;
      const yearPotentialSavings = hasOptimizationLogs ? Math.round(potentialUnrealizedAnnualSavings) : ym.unrecoveredCost;
      
      // Before vs After optimization
      // Baseline expenditure (before optimization) = Total investment
      // Expenditure after optimization = Baseline - Realized Savings
      const expenditureBeforeOptimization = ym.totalInvestment;
      const expenditureAfterOptimization = Math.max(0, ym.totalInvestment - yearRealizedSavings);
      const savingsPercentage = expenditureBeforeOptimization > 0
        ? Number(((yearRealizedSavings / expenditureBeforeOptimization) * 100).toFixed(1))
        : 0;

      // Data reliability / completeness assessment
      const hasFullMonths = ym.recordsCount >= 12;
      const dataCompleteness = hasFullMonths ? 'COMPLETE' : (ym.recordsCount > 0 ? 'PARTIAL' : 'MISSING');

      return {
        ...ym,
        expenditureBeforeOptimization,
        expenditureAfterOptimization,
        verifiedRealizedSavings: yearRealizedSavings,
        potentialAnnualSavings: yearPotentialSavings,
        savingsPercentage,
        dataCompleteness,
        isEstimatedBaseline: !hasOptimizationLogs,
      };
    });

    // Format department breakdown by year into array
    const formattedDepartmentByYear: Record<number, Array<{
      departmentId: string;
      departmentName: string;
      departmentCode: string;
      totalSpend: number;
    }>> = {};

    for (const [y, depts] of Object.entries(departmentByYear)) {
      formattedDepartmentByYear[Number(y)] = Object.values(depts).map((d) => ({
        ...d,
        totalSpend: Math.round(d.totalSpend),
      }));
    }

    const latestYearObj = enrichedYearlyMetrics[enrichedYearlyMetrics.length - 1] || null;
    const summary = latestYearObj ? {
      totalInvested: latestYearObj.totalInvestment,
      totalRecovered: latestYearObj.realizedValue,
      totalUnrecovered: latestYearObj.unrecoveredCost,
      overallRecoveryRate: latestYearObj.recoveryPercentage,
      verifiedRealizedSavings: latestYearObj.verifiedRealizedSavings,
      potentialAnnualSavings: latestYearObj.potentialAnnualSavings,
      expenditureBeforeOptimization: latestYearObj.expenditureBeforeOptimization,
      expenditureAfterOptimization: latestYearObj.expenditureAfterOptimization,
      savingsPercentage: latestYearObj.savingsPercentage,
    } : null;

    return NextResponse.json({
      success: true,
      years: enrichedYearlyMetrics,
      latestYear: latestYearObj,
      summary,
      baselineYear: enrichedYearlyMetrics[0] || null,
      yoyImprovement,
      softwareByYear,
      departmentByYear: formattedDepartmentByYear,
      monthlySpendingAndSavings,
      verifiedRealizedAnnualSavings: Math.round(verifiedRealizedAnnualSavings),
      potentialUnrealizedAnnualSavings: Math.round(potentialUnrealizedAnnualSavings),
      acceptedOptimizationsCount: acceptedRecommendations.length,
      activeRecommendationsCount: activeRecommendations.length,
    });
  } catch (error: any) {
    console.error('Error computing yearly recovery analytics:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to compute yearly recovery analytics' },
      { status: 500 }
    );
  }
}
