import { HermesClient } from '@pythnetwork/hermes-client';
import { BaseError, ContractFunctionRevertedError, type Hex } from 'viem';

export function retryable(error: unknown): boolean {
  if (error instanceof BaseError) {
    const revert = error.walk(
      (e) => e instanceof ContractFunctionRevertedError,
    );
    if (
      revert instanceof ContractFunctionRevertedError &&
      ['StalePrice', 'PriceTooOld', 'PriceFeedNotFound'].includes(
        revert.data?.errorName ?? '',
      )
    )
      return true;
  }
  // Pyth's StalePrice() may bubble through Trading without being declared in
  // the curated integration ABI. Retry only this fixed, known selector.
  if (error instanceof Error && /\b0x19abf40e\b/i.test(error.message))
    return true;
  return /\b429\b|\b503\b|\b502\b|timeout|timed out/i.test(
    error instanceof Error ? error.message : '',
  );
}

/** Retry only before broadcast, always fetching a new payload. */
export async function freshSimulation<T>(
  fetch: () => Promise<Hex[]>,
  simulate: (payloads: Hex[]) => Promise<T>,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await simulate(await fetch());
    } catch (error) {
      // Pyth updates may arrive at the edge of a short on-chain max age.
      // Four attempts bound the wait at seven seconds and never retry a write.
      if (attempt >= 3 || !retryable(error)) throw error;
      await sleep(1_000 * 2 ** attempt);
    }
  }
}
export async function freshPayloads(feedId: Hex): Promise<Hex[]> {
  const key = process.env.PYTH_API_KEY?.trim();
  if (!key) throw new Error('Missing PYTH_API_KEY');
  const hermes = new HermesClient('https://pyth.dourolabs.app/hermes', {
    accessToken: key,
  });
  const update = await hermes.getLatestPriceUpdates([feedId]);
  if (update.binary.encoding !== 'hex' || !update.binary.data.length)
    throw new Error('Hermes returned no hex signed update');
  return update.binary.data.map((data) => {
    const hex = data.startsWith('0x') ? data : `0x${data}`;
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(hex))
      throw new Error('Invalid oracle update');
    return hex as Hex;
  });
}
