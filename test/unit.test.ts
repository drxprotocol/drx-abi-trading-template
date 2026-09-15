import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  type Hex,
} from 'viem';
import { abi, closeOrder, pnlBreakdown } from '../src/portfolio.js';
import { freshSimulation } from '../src/transaction.js';
import { positive } from '../src/cli.js';

test('close reverses long/short using exactly the observed size', () => {
  for (const side of [1, 2])
    assert.deepEqual(
      closeOrder({ posState: 1, posSide: side, posSize: 17n, avgPx: 100n }),
      { side: side === 1 ? 2 : 1, size: 17n, reduceOnly: true },
    );
});
test('close rejects closed, liquidated, zero-size and invalid-side positions', () => {
  for (const pos of [
    { posState: 3, posSide: 1, posSize: 1n },
    { posState: 2, posSide: 1, posSize: 1n },
    { posState: 1, posSide: 1, posSize: 0n },
    { posState: 1, posSide: 0, posSize: 1n },
  ])
    assert.throws(() => closeOrder({ ...pos, avgPx: 1n }));
});
test('PnL matches separate notional rounding and signed fee adjustments', () => {
  const pos = { posState: 1, posSide: 1, posSize: 9999n, avgPx: 2n };
  assert.deepEqual(pnlBreakdown(pos, 3n, -1n), {
    pricePnL: 1n,
    fundingAndBorrowingAdjustment: 2n,
    netUnrealizedPnL: -1n,
  });
  assert.equal(pnlBreakdown({ ...pos, posSide: 2 }, 3n, 0n).pricePnL, -1n);
});
test('positive protocol amounts reject fractions, signs and zero', () => {
  for (const x of ['0', '-1', '1.2', '1e6', '0x10', '+1', ''])
    assert.throws(() => positive(x));
  assert.equal(positive('1000000'), 1000000n);
});
test('stale simulation retries with a newly fetched payload', async () => {
  let calls = 0;
  const payloads: Hex[] = [];
  const errorAbi = [{ type: 'error', name: 'StalePrice', inputs: [] }] as const;
  const stale = new ContractFunctionRevertedError({
    abi: errorAbi,
    data: encodeErrorResult({ abi: errorAbi, errorName: 'StalePrice' }),
    functionName: 'executeMarketOrder',
  });
  const result = await freshSimulation(
    async () => [`0x0${++calls}` as Hex],
    async (data) => {
      payloads.push(data[0]);
      if (calls === 1)
        throw new BaseError('simulation failed', { cause: stale });
      return 'ok';
    },
    async () => {},
  );
  assert.equal(result, 'ok');
  assert.deepEqual(payloads, ['0x01', '0x02']);
});
test('rate limits back off; invalid transactions do not retry', async () => {
  const delays: number[] = [];
  let calls = 0;
  await assert.rejects(
    freshSimulation(
      async () => {
        calls++;
        throw new Error('429');
      },
      async () => 0,
      async (ms) => {
        delays.push(ms);
      },
    ),
  );
  assert.equal(calls, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
  calls = 0;
  await assert.rejects(
    freshSimulation(
      async () => {
        calls++;
        return ['0x01'];
      },
      async () => {
        throw new Error('InsufficientMargin');
      },
    ),
  );
  assert.equal(calls, 1);
});
test('an undecoded Pyth StalePrice selector is retried', async () => {
  let calls = 0;
  const result = await freshSimulation(
    async () => [`0x0${++calls}` as Hex],
    async () => {
      if (calls === 1)
        throw new Error('execution reverted: custom error 0x19abf40e');
      return 'recovered';
    },
    async () => {},
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
});
test('only public integration surfaces are exported', () => {
  for (const name of ['IsolatedMarginPortfolio', 'CrossMarginPortfolio']) {
    const functions = abi(name)
      .filter((x) => x.type === 'function')
      .map((x) => x.name);
    assert.ok(functions.includes('getPosByInstId'));
    for (const forbidden of [
      'addMargin',
      'reduceMargin',
      'executeTakerFill',
      'initialize',
      'grantRole',
    ])
      assert.ok(!functions.includes(forbidden));
  }
  for (const name of ['CommonHelper', 'OrderBook'])
    assert.ok(
      abi(name).every(
        (x) => x.type === 'function' && x.stateMutability === 'view',
      ),
    );
});
