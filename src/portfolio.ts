import { readFileSync } from 'node:fs';
import { erc20Abi, type Abi, type Address, type PublicClient } from 'viem';
import type { NetworkConfig } from './network.js';

export function abi(name: string): Abi {
  return JSON.parse(
    readFileSync(new URL(`../abi/${name}.json`, import.meta.url), 'utf8'),
  ) as Abi;
}
export interface Position {
  posState: number;
  posSide: number;
  posSize: bigint;
  avgPx: bigint;
}
export function closeOrder(position: Position) {
  if (
    position.posState !== 1 ||
    position.posSize <= 0n ||
    ![1, 2].includes(position.posSide)
  )
    throw new Error('No open position to close');
  return {
    side: position.posSide === 1 ? 2 : 1,
    size: position.posSize,
    reduceOnly: true,
  };
}
export function pnlBreakdown(
  position: Position,
  price: bigint,
  netPnL: bigint,
) {
  // Match the contract: truncate each notional separately, then subtract.
  const pricePnL =
    ((position.posSize * price) / 10000n -
      (position.posSize * position.avgPx) / 10000n) *
    (position.posSide === 2 ? -1n : 1n);
  return {
    pricePnL,
    fundingAndBorrowingAdjustment: pricePnL - netPnL,
    netUnrealizedPnL: netPnL,
  };
}
export function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
}

/** One block snapshot; PnL unavailable is explicit, never silently reported as zero. */
export async function readPortfolio(
  client: PublicClient,
  config: NetworkConfig,
  portfolio: Address,
  type: 'imp' | 'cmp',
  instId: bigint,
) {
  const blockNumber = await client.getBlockNumber();
  const portfolioAbi = abi(
    type === 'imp' ? 'IsolatedMarginPortfolio' : 'CrossMarginPortfolio',
  );
  const read = (functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: portfolio,
      abi: portfolioAbi,
      functionName,
      args,
      blockNumber,
    });
  const [
    position,
    balance,
    availableBalance,
    frozenBalance,
    leverage,
    activeInstruments,
    helper,
  ] = await Promise.all([
    read('getPosByInstId', [instId]) as Promise<Position>,
    client.readContract({
      address: config.contracts.settlementToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [portfolio],
      blockNumber,
    }),
    read('getAvailableAssetBalance'),
    read('getFrozenAssetAmount'),
    read('getLeverage', [instId]),
    read('getMyPosInstIds'),
    read('h') as Promise<Address>,
  ]);
  const orderBook = (await client.readContract({
    address: helper,
    abi: abi('CommonHelper'),
    functionName: 'getOrderBookByInstId',
    args: [instId],
    blockNumber,
  })) as Address;
  const [pendingOrders, pendingOrderIds] = (await client.readContract({
    address: orderBook,
    abi: abi('OrderBook'),
    functionName: 'getPortfolioPendingOrdersData',
    args: [portfolio],
    blockNumber,
  })) as [unknown[], bigint[]];
  let valuation: unknown = { status: 'no-open-position' };
  if (position.posState === 1) {
    try {
      const [price, scale] = (await client.readContract({
        address: config.contracts.oracleRouter,
        abi: abi('OracleRouter'),
        functionName: 'getInstPrice',
        args: [instId],
        blockNumber,
      })) as [bigint, bigint];
      const [netPnL, netMargin, grossMargin] = await Promise.all([
        read('getPositionUnrealizedPnL', [
          instId,
          price,
          position,
        ]) as Promise<bigint>,
        read('getPosNetMargin', [instId, price, position]),
        read('getPosGrossMargin', [instId]),
      ]);
      valuation = {
        status: 'available',
        price,
        scale,
        ...pnlBreakdown(position, price, netPnL),
        netMargin,
        grossMargin,
      };
    } catch {
      valuation = {
        status: 'unavailable',
        reason:
          'Oracle or valuation read failed at this block; do not interpret as zero PnL.',
      };
    }
  }
  return {
    blockNumber,
    portfolio,
    instId,
    position,
    balance,
    availableBalance,
    frozenBalance,
    leverage,
    activeInstruments,
    orderBook,
    pendingOrders,
    pendingOrderIds,
    valuation,
  };
}
