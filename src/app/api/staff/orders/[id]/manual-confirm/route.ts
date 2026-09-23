import { NextResponse } from 'next/server';
import { requireApiUser } from '@/lib/authz';
import { LicenseError } from '@/lib/license';
import { confirmOrderManually, manualConfirmationPreview, ManualConfirmationError } from '@/lib/orders/manual-confirmation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function failure(error: unknown) {
    if (error instanceof ManualConfirmationError)
        return NextResponse.json({ error: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : error.code === 'INVALID_INPUT' ? 400 : 409 });
    if (error instanceof LicenseError)
        return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
}
export async function GET(_request: Request, { params }: {
    params: {
        id: string;
    };
}) {
    const auth = await requireApiUser(['STAFF', 'ADMIN']);
    if ('response' in auth)
        return auth.response;
    try {
        return NextResponse.json(await manualConfirmationPreview({ storeId: auth.user.storeId, orderId: params.id, actor: auth.user }), { headers: { 'cache-control': 'private, no-store' } });
    }
    catch (e) {
        return failure(e);
    }
}
export async function POST(request: Request, { params }: {
    params: {
        id: string;
    };
}) {
    const auth = await requireApiUser(['STAFF', 'ADMIN'], 'commerce-core');
    if ('response' in auth)
        return auth.response;
    try {
        return NextResponse.json(await confirmOrderManually({ storeId: auth.user.storeId, orderId: params.id, actor: auth.user, confirmation: await request.json().catch(() => null) }));
    }
    catch (e) {
        return failure(e);
    }
}
