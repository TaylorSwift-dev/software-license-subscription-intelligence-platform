import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAuth } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit';
import { AuditAction, Role, LicenseType, BillingFrequency, LicenseStatus } from '@prisma/client';

export async function GET(req: NextRequest) {
  const { user, errorResponse } = requireAuth(req);
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(req.url);
    const softwareId = searchParams.get('softwareId');
    const status = searchParams.get('status') as LicenseStatus | null;

    const where: any = {};
    if (softwareId) where.softwareId = softwareId;
    if (status) where.status = status;

    const licenses = await prisma.license.findMany({
      where,
      include: {
        software: { include: { vendor: true } },
        assignments: {
          where: { status: 'ACTIVE' },
          include: {
            user: { select: { id: true, name: true, email: true, designation: true } },
            department: { select: { id: true, name: true, code: true } },
          },
        },
        renewals: true,
      },
      orderBy: { renewalDate: 'asc' },
    });

    const enriched = licenses.map((lic) => {
      const isToken = lic.consumptionType === 'TOKEN_BASED';
      const allocatedTokens = lic.allocatedTokens || 0;
      const usedTokens = lic.usedTokens || 0;
      const remainingTokens = Math.max(0, allocatedTokens - usedTokens);
      const tokenUnitCost = lic.tokenUnitCost || 0;

      const assignedQuantity = lic.assignments.length;
      const availableQuantity = Math.max(0, lic.totalQuantity - assignedQuantity);
      const unusedQuantity = availableQuantity;
      
      const utilizationRate = isToken && allocatedTokens > 0
        ? Number(((usedTokens / allocatedTokens) * 100).toFixed(1))
        : (lic.totalQuantity > 0 
          ? Number(((assignedQuantity / lic.totalQuantity) * 100).toFixed(1)) 
          : 0);

      const freq = lic.billingFrequency || 'MONTHLY';
      let annualExpenditure = 0;
      let monthlyExpenditure = 0;
      let unusedAnnualCost = 0;
      let unusedMonthlyCost = 0;
      let oneTimeExpenditure = 0;

      if (isToken && allocatedTokens > 0 && tokenUnitCost > 0) {
        const tokenPoolCost = allocatedTokens * tokenUnitCost;
        const remainingCost = remainingTokens * tokenUnitCost;
        if (freq === 'ANNUAL') {
          annualExpenditure = tokenPoolCost;
          monthlyExpenditure = tokenPoolCost / 12;
          unusedAnnualCost = remainingCost;
          unusedMonthlyCost = remainingCost / 12;
        } else {
          monthlyExpenditure = tokenPoolCost;
          annualExpenditure = tokenPoolCost * 12;
          unusedMonthlyCost = remainingCost;
          unusedAnnualCost = remainingCost * 12;
        }
      } else if (freq === 'ANNUAL') {
        annualExpenditure = lic.totalQuantity * lic.costPerLicense;
        monthlyExpenditure = (lic.totalQuantity * lic.costPerLicense) / 12;
        unusedAnnualCost = unusedQuantity * lic.costPerLicense;
        unusedMonthlyCost = (unusedQuantity * lic.costPerLicense) / 12;
      } else if (freq === 'MONTHLY') {
        monthlyExpenditure = lic.totalQuantity * lic.costPerLicense;
        annualExpenditure = lic.totalQuantity * lic.costPerLicense * 12;
        unusedMonthlyCost = unusedQuantity * lic.costPerLicense;
        unusedAnnualCost = unusedQuantity * lic.costPerLicense * 12;
      } else if (freq === 'ONE_TIME') {
        oneTimeExpenditure = lic.totalQuantity * lic.costPerLicense;
        monthlyExpenditure = 0;
        annualExpenditure = 0;
        unusedMonthlyCost = 0;
        unusedAnnualCost = 0;
      }

      const potentialAnnualSaving = unusedAnnualCost;

      return {
        id: lic.id,
        licenseKey: lic.licenseKey,
        licenseType: lic.licenseType,
        consumptionType: lic.consumptionType,
        allocatedTokens,
        usedTokens,
        remainingTokens,
        tokenUnitCost,
        totalQuantity: lic.totalQuantity,
        assignedQuantity,
        availableQuantity,
        unusedQuantity,
        utilizationRate,
        costPerLicense: lic.costPerLicense,
        billingFrequency: lic.billingFrequency,
        monthlyExpenditure: Math.round(monthlyExpenditure),
        annualExpenditure: Math.round(annualExpenditure),
        unusedMonthlyCost: Math.round(unusedMonthlyCost),
        potentialAnnualSaving: Math.round(potentialAnnualSaving),
        oneTimeExpenditure: Math.round(oneTimeExpenditure),
        purchaseDate: lic.purchaseDate,
        startDate: lic.startDate,
        renewalDate: lic.renewalDate,
        expiryDate: lic.expiryDate,
        status: lic.status,
        notes: lic.notes,
        software: lic.software,
        assignments: lic.assignments,
        renewals: lic.renewals,
      };
    });

    return NextResponse.json({ success: true, count: enriched.length, licenses: enriched });
  } catch (error: any) {
    console.error('Error fetching licenses:', error);
    return NextResponse.json({ success: false, error: 'Failed to retrieve licenses' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { user, errorResponse } = requireAuth(req, [Role.ADMIN, Role.MANAGER]);
  if (errorResponse || !user) return errorResponse;

  try {
    const body = await req.json();
    const {
      softwareId,
      licenseKey,
      licenseType = LicenseType.PER_USER,
      consumptionType = 'SEAT_BASED',
      allocatedTokens,
      usedTokens,
      tokenUnitCost,
      totalQuantity,
      costPerLicense,
      billingFrequency = BillingFrequency.MONTHLY,
      purchaseDate,
      renewalDate,
      expiryDate,
      notes,
    } = body;

    if (!softwareId || !totalQuantity || costPerLicense === undefined || !renewalDate) {
      return NextResponse.json(
        { success: false, error: 'Software, total quantity, cost per license, and renewal date are required' },
        { status: 400 }
      );
    }

    const sw = await prisma.software.findUnique({ where: { id: softwareId } });
    if (!sw) {
      return NextResponse.json({ success: false, error: 'Software not found' }, { status: 404 });
    }

    const totalQty = parseInt(totalQuantity, 10);
    const cost = parseFloat(costPerLicense);
    const isToken = consumptionType === 'TOKEN_BASED';
    const parsedAllocatedTokens = isToken ? parseFloat(allocatedTokens || '0') : 0;
    const parsedUsedTokens = isToken ? parseFloat(usedTokens || '0') : 0;
    const parsedTokenUnitCost = isToken ? parseFloat(tokenUnitCost || '0') : 0;

    const license = await prisma.$transaction(async (tx) => {
      const lic = await tx.license.create({
        data: {
          softwareId,
          vendorId: sw.vendorId,
          licenseKey,
          licenseType,
          consumptionType,
          allocatedTokens: parsedAllocatedTokens,
          usedTokens: parsedUsedTokens,
          tokenUnitCost: parsedTokenUnitCost,
          totalQuantity: totalQty,
          costPerLicense: cost,
          billingFrequency,
          purchaseDate: purchaseDate ? new Date(purchaseDate) : new Date(),
          startDate: new Date(),
          renewalDate: new Date(renewalDate),
          expiryDate: expiryDate ? new Date(expiryDate) : null,
          notes,
        },
      });

      const renewalAnnualCost = isToken && parsedAllocatedTokens > 0
        ? (billingFrequency === 'ANNUAL' ? parsedAllocatedTokens * parsedTokenUnitCost : parsedAllocatedTokens * parsedTokenUnitCost * 12)
        : (billingFrequency === 'ANNUAL' ? totalQty * cost : totalQty * cost * 12);

      await tx.renewal.create({
        data: {
          softwareId,
          licenseId: lic.id,
          renewalDate: new Date(renewalDate),
          estimatedCost: Math.round(renewalAnnualCost),
        },
      });

      return lic;
    });

    await recordAuditLog({
      userId: user.userId,
      action: AuditAction.CREATE,
      entity: 'License',
      entityId: license.id,
      details: { softwareName: sw.name, totalQuantity: totalQty, costPerLicense: cost, billingFrequency },
    });

    return NextResponse.json({ success: true, license }, { status: 201 });
  } catch (error: any) {
    console.error('Error creating license:', error);
    return NextResponse.json({ success: false, error: 'Failed to create license' }, { status: 500 });
  }
}
