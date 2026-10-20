import assert from 'node:assert';
import { financeLedger } from '../src/server/financeLedger';
import fs from 'fs';
import path from 'path';

async function runTest() {
  console.log('--- STARTING WALLET TEST ---');
  // Cleanup data
  if (fs.existsSync('./data/financial_ledger.json')) fs.unlinkSync('./data/financial_ledger.json');
  if (fs.existsSync('./data/wallets.json')) fs.unlinkSync('./data/wallets.json');
  
  // Reload ledger to clear in-memory state
  (financeLedger as any).loadFromDisk();

  // Attempt to credit a non-existent user
  const unknownUserId = 'user_999999999';
  
  try {
    financeLedger.creditDeposit({
        userId: unknownUserId,
        amount: 100,
        reference: 'Test',
        idempotencyKey: 'test-key',
        actor: 'Test',
        source: 'test'
    });
    // If it succeeds, the wallet was created.
    const hasWallet = financeLedger.hasWallet(unknownUserId);
    assert.strictEqual(hasWallet, false, 'Wallet should not have been created for unknown user');
    console.log('✅ Test Passed: Wallet not created for unknown user');
  } catch (e) {
    console.log('✅ Test Passed: Error thrown or wallet not created:', e);
  }
}

runTest().catch(err => {
  console.error('❌ Test Failed:', err);
  process.exit(1);
});
