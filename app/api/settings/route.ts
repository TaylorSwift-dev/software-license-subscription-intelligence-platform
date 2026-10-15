import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { Role } from '@prisma/client';

// Local persistent settings cache
let cachedSettings = {
  underutilizationThreshold: 70,
  currency: 'INR',
  financialPrimaryModel: 'ANNUAL',
  fiscalYearStartMonth: 4, // April for INR
  tokenLowThreshold: 40,
  tokenCriticalThreshold: 95,
  autoRenewNotificationsDays: 30,
};

export async function GET(req: NextRequest) {
  const { user, errorResponse } = requireAuth(req);
  if (errorResponse) return errorResponse;

  return NextResponse.json({
    success: true,
    settings: cachedSettings,
  });
}

export async function POST(req: NextRequest) {
  const { user, errorResponse } = requireAuth(req, [Role.ADMIN, Role.MANAGER]);
  if (errorResponse) return errorResponse;

  try {
    const body = await req.json();
    cachedSettings = {
      ...cachedSettings,
      ...body,
    };

    return NextResponse.json({
      success: true,
      message: 'Settings updated successfully',
      settings: cachedSettings,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
