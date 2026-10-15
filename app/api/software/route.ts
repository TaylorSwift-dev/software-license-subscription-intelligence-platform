import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAuth } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit';
import { AuditAction, Role, SoftwareStatus } from '@prisma/client';

export async function GET(req: NextRequest) {
  const { user, errorResponse } = requireAuth(req);
  if (errorResponse) return errorResponse;

  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search') || '';
    const category = searchParams.get('category');
    const status = searchParams.get('status') as SoftwareStatus | null;

    const whereClause: any = {};
    if (search) {
      whereClause.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
        { vendor: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (category) {
      whereClause.category = category;
    }
    if (status) {
      whereClause.status = status;
    }

    const softwareList = await prisma.software.findMany({
      where: whereClause,
      include: {
        vendor: true,
        licenses: {
          include: {
            assignments: {
              where: { status: 'ACTIVE' },
              include: {
                user: { select: { id: true, name: true, email: true, designation: true } },
                department: { select: { id: true, name: true, code: true } },
              },
            },
            renewals: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const enriched = softwareList.map((sw) => {
      let totalLicenses = 0;
      let activeAssignments = 0;
      let monthlyCost = 0;
      let annualCost = 0;
      let oneTimeCost = 0;
      let unusedMonthlyCost = 0;
      let unusedAnnualCost = 0;
      let costPerLicense = 0;
      let allocatedTokens = 0;
      let usedTokens = 0;
      let tokenUnitCost = 0;

      for (const lic of sw.licenses) {
        const isToken = sw.consumptionType === 'TOKEN_BASED' || lic.consumptionType === 'TOKEN_BASED';
        const freq = lic.billingFrequency || 'MONTHLY';
        const licTotal = lic.totalQuantity;
        const licActive = lic.assignments.length;
        const licUnused = Math.max(0, licTotal - licActive);
        costPerLicense = lic.costPerLicense;

        if (isToken) {
          allocatedTokens += lic.allocatedTokens || 0;
          usedTokens += lic.usedTokens || 0;
          tokenUnitCost = lic.tokenUnitCost || 0;
          activeAssignments += licActive;
          totalLicenses += licTotal;

          const poolCost = (lic.allocatedTokens || 0) * (lic.tokenUnitCost || 0);
          const remainingCost = Math.max(0, (lic.allocatedTokens || 0) - (lic.usedTokens || 0)) * (lic.tokenUnitCost || 0);

          if (freq === 'ANNUAL') {
            annualCost += poolCost;
            monthlyCost += poolCost / 12;
            unusedAnnualCost += remainingCost;
            unusedMonthlyCost += remainingCost / 12;
          } else {
            monthlyCost += poolCost;
            annualCost += poolCost * 12;
            unusedMonthlyCost += remainingCost;
            unusedAnnualCost += remainingCost * 12;
          }
        } else {
          totalLicenses += licTotal;
          activeAssignments += licActive;

          if (freq === 'ANNUAL') {
            annualCost += licTotal * lic.costPerLicense;
            monthlyCost += (licTotal * lic.costPerLicense) / 12;
            unusedAnnualCost += licUnused * lic.costPerLicense;
            unusedMonthlyCost += (licUnused * lic.costPerLicense) / 12;
          } else if (freq === 'MONTHLY') {
            monthlyCost += licTotal * lic.costPerLicense;
            annualCost += licTotal * lic.costPerLicense * 12;
            unusedMonthlyCost += licUnused * lic.costPerLicense;
            unusedAnnualCost += licUnused * lic.costPerLicense * 12;
          } else if (freq === 'ONE_TIME') {
            oneTimeCost += licTotal * lic.costPerLicense;
          }
        }
      }

      const availableLicenses = Math.max(0, totalLicenses - activeAssignments);
      const unusedLicenses = availableLicenses;
      const utilizationRate = sw.consumptionType === 'TOKEN_BASED' && allocatedTokens > 0
        ? Number(((usedTokens / allocatedTokens) * 100).toFixed(1))
        : (totalLicenses > 0 
          ? Number(((activeAssignments / totalLicenses) * 100).toFixed(1)) 
          : 0);

      return {
        id: sw.id,
        name: sw.name,
        category: sw.category,
        description: sw.description,
        version: sw.version,
        website: sw.website,
        status: sw.status,
        consumptionType: sw.consumptionType,
        vendor: sw.vendor,
        totalLicenses,
        activeAssignments,
        availableLicenses,
        unusedLicenses,
        allocatedTokens,
        usedTokens,
        tokenUnitCost,
        utilizationRate,
        costPerLicense,
        monthlyCost: Math.round(monthlyCost),
        annualCost: Math.round(annualCost),
        oneTimeCost: Math.round(oneTimeCost),
        unusedMonthlyCost: Math.round(unusedMonthlyCost),
        potentialAnnualSaving: Math.round(unusedAnnualCost),
        licenses: sw.licenses,
        createdAt: sw.createdAt,
      };
    });

    return NextResponse.json({ success: true, count: enriched.length, software: enriched });
  } catch (error: any) {
    console.error('Error fetching software catalog:', error);
    return NextResponse.json({ success: false, error: 'Failed to retrieve software catalog' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { user, errorResponse } = requireAuth(req, [Role.ADMIN, Role.MANAGER]);
  if (errorResponse || !user) return errorResponse;

  try {
    const body = await req.json();
    const {
      name,
      category,
      description,
      version,
      website,
      vendorId,
      initialLicenses,
      costPerLicense,
      consumptionType = 'SEAT_BASED',
      billingFrequency = 'MONTHLY',
      allocatedTokens,
      tokenUnitCost,
    } = body;

    if (!name || !category || !vendorId) {
      return NextResponse.json(
        { success: false, error: 'Name, category, and vendor are required' },
        { status: 400 }
      );
    }

    const existing = await prisma.software.findUnique({ where: { name: name.trim() } });
    if (existing) {
      return NextResponse.json(
        { success: false, error: 'A software product with this name already exists' },
        { status: 409 }
      );
    }

    const isToken = consumptionType === 'TOKEN_BASED';
    const parsedAllocatedTokens = isToken ? parseFloat(allocatedTokens || '0') : 0;
    const parsedTokenUnitCost = isToken ? parseFloat(tokenUnitCost || '0') : 0;
    const totalQty = parseInt(initialLicenses || '1', 10);
    const cost = parseFloat(costPerLicense || '0');

    const software = await prisma.$transaction(async (tx) => {
      const sw = await tx.software.create({
        data: {
          name: name.trim(),
          category: category.trim(),
          description,
          version,
          website,
          vendorId,
          consumptionType,
        },
      });

      if (totalQty > 0 || (isToken && parsedAllocatedTokens > 0)) {
        const renewalDate = new Date();
        renewalDate.setFullYear(renewalDate.getFullYear() + 1);

        const lic = await tx.license.create({
          data: {
            softwareId: sw.id,
            vendorId,
            consumptionType,
            billingFrequency,
            allocatedTokens: parsedAllocatedTokens,
            usedTokens: 0,
            tokenUnitCost: parsedTokenUnitCost,
            totalQuantity: totalQty,
            costPerLicense: cost,
            renewalDate,
            notes: 'Initial license provisioning',
          },
        });

        const estAnnual = isToken && parsedAllocatedTokens > 0
          ? (billingFrequency === 'ANNUAL' ? parsedAllocatedTokens * parsedTokenUnitCost : parsedAllocatedTokens * parsedTokenUnitCost * 12)
          : (billingFrequency === 'ANNUAL' ? totalQty * cost : totalQty * cost * 12);

        await tx.renewal.create({
          data: {
            softwareId: sw.id,
            licenseId: lic.id,
            renewalDate,
            estimatedCost: Math.round(estAnnual),
          },
        });
      }

      return sw;
    });

    await recordAuditLog({
      userId: user.userId,
      action: AuditAction.CREATE,
      entity: 'Software',
      entityId: software.id,
      details: { name: software.name, category: software.category },
    });

    return NextResponse.json({ success: true, software }, { status: 201 });
  } catch (error: any) {
    console.error('Error creating software:', error);
    return NextResponse.json({ success: false, error: 'Failed to create software record' }, { status: 500 });
  }
}
