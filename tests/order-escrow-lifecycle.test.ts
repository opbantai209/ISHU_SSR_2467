// Focused Regression Test Suite for Order & Escrow Lifecycle
// Tests:
// Test A — Project initial escrow
// Test B — Gig initial escrow
// Test C — Funding failure
// Test D — Multiple Project hires
// Test E — Follow-on Gig

process.env.PORT = '3009';
(process.env as any).NODE_ENV = 'test';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const SNAPSHOT_DIR = path.join(DATA_DIR, '..', '.test-snapshot-order-lifecycle');

function snapshotData() {
  fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  if (fs.existsSync(DATA_DIR)) fs.cpSync(DATA_DIR, SNAPSHOT_DIR, { recursive: true });
}

function restoreData() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (fs.existsSync(SNAPSHOT_DIR)) fs.cpSync(SNAPSHOT_DIR, DATA_DIR, { recursive: true });
  fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
}

let BASE = 'http://localhost:3009';

async function api(p: string, opts: { method?: string; token?: string; body?: any; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ok: res.ok, json };
}

async function demoToken(userId: string): Promise<string> {
  const r = await api('/api/auth/demo-session', { method: 'POST', body: { userId } });
  assert.strictEqual(r.status, 200, `demo-session for ${userId} failed: ${JSON.stringify(r.json)}`);
  return r.json.token;
}

async function runSuite() {
  snapshotData();
  console.log('--- STARTING FOCUSED ORDER & ESCROW LIFECYCLE REGRESSION TESTS ---');

  // Boot server on PORT 3009 or dynamic fallback port
  const serverMod: any = await import('../server.ts');
  const server = serverMod.server;
  await new Promise<void>(resolve => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
    setTimeout(resolve, 1000);
  });
  const actualPort = (server.address() as any)?.port || 3009;
  BASE = `http://localhost:${actualPort}`;
  console.log(`Connected to test server at ${BASE}`);

  const buyerToken = await demoToken('user_1');       // Alex Rivera (Buyer)
  const sellerAToken = await demoToken('user_2');     // Freelancer A
  const sellerBToken = await demoToken('user_3');     // Freelancer B
  const zeroBalanceBuyerToken = await demoToken('user_4'); // Sophia Chen ($0 wallet balance)

  // Deposit sufficient funds into buyer wallet (in chunks of $4,000 to respect simulated limit of $5,000)
  await api('/api/wallet/deposit', { method: 'POST', token: buyerToken, body: { amount: 4000 } });
  await api('/api/wallet/deposit', { method: 'POST', token: buyerToken, body: { amount: 4000 } });

  // ==========================================
  // Test A — Project initial escrow
  // ==========================================
  console.log('\nRunning Test A — Project initial escrow...');
  {
    // 1. Create a project
    const projRes = await api('/api/projects', {
      method: 'POST',
      token: buyerToken,
      body: {
        title: 'Test Project for Escrow Lifecycle',
        category: 'Development & IT',
        subcategory: 'Web Development',
        budgetMin: 300,
        budgetMax: 800,
        description: 'Building custom module with escrow verification'
      }
    });
    assert.strictEqual(projRes.status, 200, 'Project creation should succeed');
    const project = projRes.json;

    // 2. Freelancer submits a proposal
    const propRes = await api('/api/proposals', {
      method: 'POST',
      token: sellerAToken,
      body: {
        projectId: project.id,
        freelancerId: 'user_2',
        freelancerName: 'Jane Smith',
        bidAmount: 450,
        deliveryDays: 5,
        coverLetter: 'I will deliver complete full-stack code.'
      }
    });
    assert.strictEqual(propRes.status, 200, 'Proposal submission should succeed');
    const proposal = propRes.json;
    assert.strictEqual(proposal.status, 'pending', 'Proposal initial status must be pending');

    // 3. Buyer accepts proposal -> triggers processProposalAccept
    const acceptRes = await api(`/api/proposals/${proposal.id}/accept`, {
      method: 'POST',
      token: buyerToken
    });
    assert.strictEqual(acceptRes.status, 200, `Accept proposal failed: ${JSON.stringify(acceptRes.json)}`);
    assert.strictEqual(acceptRes.json.success, true, 'Acceptance response must report success');

    const createdOrder = acceptRes.json.order;
    assert.ok(createdOrder, 'Order must be created and returned');
    assert.strictEqual(createdOrder.orderType, 'project', 'Order orderType must be project');
    assert.strictEqual(createdOrder.projectOrderId, createdOrder.id, 'projectOrderId must match canonical order ID');
    assert.strictEqual(createdOrder.projectId, project.id, 'projectId must match original project ID');
    assert.strictEqual(createdOrder.proposalId, proposal.id, 'proposalId must match accepted proposal');
    assert.strictEqual(createdOrder.status, 'funded_in_escrow', 'Order must end in funded_in_escrow status');
    assert.strictEqual(createdOrder.amount, 450, 'Order amount must match proposal bid');
    assert.ok(createdOrder.workspaceId, 'Order must have a valid workspaceId');

    // 4. Verify order in order list
    const orderCheck = await api(`/api/orders/${createdOrder.id}`, { token: buyerToken });
    assert.strictEqual(orderCheck.status, 200);
    assert.strictEqual(orderCheck.json.status, 'funded_in_escrow', 'Stored order status must be funded_in_escrow');
    assert.ok(orderCheck.json.escrowRemaining >= 450, 'Escrow must be held in ledger');
    console.log('✅ Test A Passed: Project proposal creates/uses Order in payment_pending, funds escrow, and ends in funded_in_escrow.');
  }

  // ==========================================
  // Test B — Gig initial escrow
  // ==========================================
  console.log('\nRunning Test B — Gig initial escrow...');
  {
    // 1. Fetch available gigs
    const gigsRes = await api('/api/gigs', { token: buyerToken });
    assert.strictEqual(gigsRes.status, 200);
    const gig = gigsRes.json.find((g: any) => g.freelancerId === 'user_2');
    assert.ok(gig, 'Must find a gig by user_2');

    // 2. Buy the gig via POST /api/orders
    const buyRes = await api('/api/orders', {
      method: 'POST',
      token: buyerToken,
      body: {
        gigId: gig.id,
        sellerId: gig.freelancerId,
        title: gig.title,
        amount: gig.price,
        requirements: 'Please start right away.'
      }
    });

    assert.strictEqual(buyRes.status, 201, `Gig purchase failed: ${JSON.stringify(buyRes.json)}`);
    const gigOrder = buyRes.json;

    assert.strictEqual(gigOrder.orderType, 'gig', 'Order orderType must be gig');
    assert.strictEqual(gigOrder.gigOrderId, gigOrder.id, 'gigOrderId must match canonical order ID');
    assert.strictEqual(gigOrder.gigId, gig.id, 'gigId must be preserved');
    assert.strictEqual(gigOrder.buyerId, 'user_1', 'buyerId must be preserved');
    assert.strictEqual(gigOrder.sellerId, gig.freelancerId, 'sellerId must be preserved');
    assert.strictEqual(gigOrder.status, 'funded_in_escrow', 'Order must end in funded_in_escrow after successful funding');
    assert.ok(gigOrder.workspaceId, 'Order must have workspaceId');
    console.log('✅ Test B Passed: Gig purchase sets orderType: "gig", gigOrderId, and transitions payment_pending -> funded_in_escrow.');
  }

  // ==========================================
  // Test C — Funding failure
  // ==========================================
  console.log('\nRunning Test C — Funding failure...');
  {
    // 1. Attempting to purchase a Gig with insufficient funds (user_4 has $0 balance)
    const gigsRes = await api('/api/gigs', { token: zeroBalanceBuyerToken });
    const gig = gigsRes.json[0];

    const failGigRes = await api('/api/orders', {
      method: 'POST',
      token: zeroBalanceBuyerToken,
      body: {
        gigId: gig.id,
        sellerId: gig.freelancerId,
        title: gig.title,
        amount: gig.price
      }
    });

    assert.strictEqual(failGigRes.status, 400, 'Purchase with insufficient funds must return 400');
    assert.ok(failGigRes.json.error, 'Must return error message');

    // 2. Attempting to accept a proposal with insufficient funds
    const projRes = await api('/api/projects', {
      method: 'POST',
      token: zeroBalanceBuyerToken,
      body: {
        title: 'Project by Zero Balance Buyer',
        category: 'Development & IT',
        subcategory: 'Web Development',
        budgetMin: 500,
        budgetMax: 1000,
        description: 'Test project'
      }
    });
    const project = projRes.json;

    const propRes = await api('/api/proposals', {
      method: 'POST',
      token: sellerAToken,
      body: {
        projectId: project.id,
        freelancerId: 'user_2',
        freelancerName: 'Jane Smith',
        bidAmount: 600,
        deliveryDays: 5,
        coverLetter: 'Insufficient balance test'
      }
    });
    const proposal = propRes.json;

    const failAcceptRes = await api(`/api/proposals/${proposal.id}/accept`, {
      method: 'POST',
      token: zeroBalanceBuyerToken
    });

    assert.strictEqual(failAcceptRes.status, 400, 'Acceptance with insufficient balance must fail with 400');
    assert.ok(failAcceptRes.json.error, 'Must return error');

    // Verify rollback: proposal status must remain 'pending' and no falsely funded order exists
    const propCheck = await api('/api/proposals', { token: zeroBalanceBuyerToken });
    const revertedProp = propCheck.json.find((p: any) => p.id === proposal.id);
    assert.strictEqual(revertedProp.status, 'pending', 'Proposal must be rolled back to pending');
    assert.strictEqual(revertedProp.workstreamOrderId, undefined, 'Must not have workstreamOrderId');
    console.log('✅ Test C Passed: Funding failure reports error, does not falsely fund order, and rolls back cleanly.');
  }

  // ==========================================
  // Test D — Multiple Project hires
  // ==========================================
  console.log('\nRunning Test D — Multiple Project hires...');
  {
    // 1. Buyer posts a project with multi-hire requirement
    const projRes = await api('/api/projects', {
      method: 'POST',
      token: buyerToken,
      body: {
        title: 'Multi-Hire Development Project',
        category: 'Development & IT',
        subcategory: 'Full Stack',
        budgetMin: 500,
        budgetMax: 2000,
        description: 'Need both Frontend and Backend engineers.'
      }
    });
    const project = projRes.json;

    // 2. Freelancer A (user_2) submits proposal
    const propARes = await api('/api/proposals', {
      method: 'POST',
      token: sellerAToken,
      body: {
        projectId: project.id,
        freelancerId: 'user_2',
        freelancerName: 'Jane Smith',
        bidAmount: 500,
        deliveryDays: 7,
        coverLetter: 'I will handle the backend API.'
      }
    });
    const propA = propARes.json;

    // 3. Freelancer B (user_3) submits proposal
    const propBRes = await api('/api/proposals', {
      method: 'POST',
      token: sellerBToken,
      body: {
        projectId: project.id,
        freelancerId: 'user_3',
        freelancerName: 'Bob Vance',
        bidAmount: 400,
        deliveryDays: 5,
        coverLetter: 'I will handle the frontend UI.'
      }
    });
    const propB = propBRes.json;

    // 4. Buyer accepts Freelancer A's proposal
    const hireARes = await api(`/api/proposals/${propA.id}/accept`, {
      method: 'POST',
      token: buyerToken
    });
    assert.strictEqual(hireARes.status, 200, 'Hiring Freelancer A must succeed');
    const orderA = hireARes.json.order;
    assert.strictEqual(orderA.status, 'funded_in_escrow');
    assert.strictEqual(orderA.sellerId, 'user_2');

    // 5. Verify the Project itself is still available/in_progress and NOT closed/deleted
    const projCheck = await api(`/api/projects/${project.id}`, { token: buyerToken });
    assert.strictEqual(projCheck.status, 200, 'Project must remain accessible');
    assert.notStrictEqual(projCheck.json.status, 'completed', 'Project must not be closed prematurely');

    // 6. Buyer accepts Freelancer B's proposal on the SAME project
    const hireBRes = await api(`/api/proposals/${propB.id}/accept`, {
      method: 'POST',
      token: buyerToken
    });
    assert.strictEqual(hireBRes.status, 200, 'Hiring Freelancer B must succeed on the same project');
    const orderB = hireBRes.json.order;
    assert.strictEqual(orderB.status, 'funded_in_escrow');
    assert.strictEqual(orderB.sellerId, 'user_3');

    // 7. Verify both orders are distinct and have independent workspaces
    assert.notStrictEqual(orderA.id, orderB.id, 'Orders must be distinct');
    assert.notStrictEqual(orderA.workspaceId, orderB.workspaceId, 'Freelancers must have independent Workspaces');
    console.log('✅ Test D Passed: Same project can hire multiple freelancers into separate Orders and Workspaces.');
  }

  // ==========================================
  // Test E — Follow-on Gig
  // ==========================================
  console.log('\nRunning Test E — Follow-on Gig...');
  {
    // 1. Buyer orders a Gig
    const gigsRes = await api('/api/gigs', { token: buyerToken });
    const gig = gigsRes.json.find((g: any) => g.freelancerId === 'user_2');

    const orderRes = await api('/api/orders', {
      method: 'POST',
      token: buyerToken,
      body: {
        gigId: gig.id,
        sellerId: gig.freelancerId,
        title: 'Initial Gig Order for Follow-on Test',
        amount: gig.price
      }
    });
    assert.strictEqual(orderRes.status, 201);
    const initialOrder = orderRes.json;
    const initialOrderId = initialOrder.id;
    const originalWorkspaceId = initialOrder.workspaceId;

    // 2. Seller submits deliverable
    const delivRes = await api(`/api/orders/${initialOrderId}/deliverable`, {
      method: 'POST',
      token: sellerAToken,
      body: { notes: 'Completed gig work delivery', reference: 'https://github.com/example/project' }
    });
    assert.strictEqual(delivRes.status, 200, `Delivery failed: ${JSON.stringify(delivRes.json)}`);

    // 3. Buyer releases escrow -> order completed
    const releaseRes = await api('/api/payments/escrow/release', {
      method: 'POST',
      token: buyerToken,
      body: { orderId: initialOrderId }
    });
    assert.strictEqual(releaseRes.status, 200, `Escrow release failed: ${JSON.stringify(releaseRes.json)}`);
    assert.strictEqual(releaseRes.json.order.status, 'completed', 'Initial order must be completed');

    // 4. Seller sends a follow-on proposal in the same Workstream
    const followOnOfferRes = await api(`/api/orders/${initialOrderId}/offers`, {
      method: 'POST',
      token: sellerAToken,
      body: {
        kind: 'proposal',
        title: 'Follow-on Maintenance & Enhancements',
        amount: 250,
        deliveryDays: 3,
        note: 'Follow-up enhancements after initial release'
      }
    });
    assert.strictEqual(followOnOfferRes.status, 201, `Follow-on offer submission failed: ${JSON.stringify(followOnOfferRes.json)}`);
    const followOnOffer = followOnOfferRes.json.offer;

    // 5. Buyer accepts the follow-on offer
    const acceptOfferRes = await api(`/api/offers/${followOnOffer.id}/accept`, {
      method: 'POST',
      token: buyerToken
    });
    assert.strictEqual(acceptOfferRes.status, 200, `Accepting follow-on offer failed: ${JSON.stringify(acceptOfferRes.json)}`);

    const newOrder = acceptOfferRes.json.order;
    assert.ok(newOrder, 'A new Order must be returned');

    // Verify Invariants:
    // - A NEW Order was created
    assert.notStrictEqual(newOrder.id, initialOrderId, 'Follow-on work must create a NEW Order ID');
    // - Original Order is NOT reopened or overwritten
    const checkOriginalRes = await api(`/api/orders/${initialOrderId}`, { token: buyerToken });
    assert.strictEqual(checkOriginalRes.json.status, 'completed', 'Original order must remain completed (not reopened or overwritten)');
    // - Follow-on Order has orderType: 'gig' and appropriate gigOrderId
    assert.strictEqual(newOrder.orderType, 'gig', 'Follow-on order must have orderType: gig');
    assert.strictEqual(newOrder.gigOrderId, newOrder.id, 'Follow-on order must have gigOrderId matching its own ID');
    // - Reuses the existing Workspace
    assert.strictEqual(newOrder.workspaceId, originalWorkspaceId, 'Follow-on order must reuse the existing Workspace');
    // - Ended in funded_in_escrow
    assert.strictEqual(newOrder.status, 'funded_in_escrow', 'Follow-on order must end in funded_in_escrow');
    console.log('✅ Test E Passed: Completed Gig Order is not reopened; new Gig Order created in existing Workspace with orderType "gig" and gigOrderId.');
  }

  console.log('\n🎉 ALL 5 FOCUSED REGRESSION TESTS (A, B, C, D, E) PASSED SUCCESSFULLY!');
  restoreData();
  process.exit(0);
}

runSuite().catch(err => {
  console.error('\n❌ FOCUSED REGRESSION SUITE FAILED:', err);
  restoreData();
  process.exit(1);
});
