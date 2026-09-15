/** Opt-in integration tests. The only writable chain is an Anvil process started here. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { HermesClient } from '@pythnetwork/hermes-client';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  isAddress,
  parseEther,
  toHex,
  zeroAddress,
  type Address,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { abi, readPortfolio } from '../src/portfolio.js';
import { connectNetwork } from '../src/network.js';

const exec = promisify(execFile);
function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(
      `Missing ${name}; see docs/TESTING.md. No live transaction was submitted.`,
    );
  return value;
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test(
  'fork: IMP and CMP creation, funding, leverage, order and collateral lifecycle',
  { timeout: 600_000 },
  async (t) => {
    // Fail rather than skip when explicitly invoked without its fixtures.
    const forkUrl = required('FORK_RPC_URL');
    const block = required('FORK_BLOCK_NUMBER');
    if (!/^[1-9][0-9]*$/.test(block))
      throw new Error('FORK_BLOCK_NUMBER must pin a positive block');
    const donor = required('FORK_SETTLEMENT_DONOR');
    if (!isAddress(donor)) throw new Error('Invalid donor');
    required('PYTH_API_KEY');
    const network = process.env.FORK_NETWORK ?? 'testnet';
    const instId = required('FORK_INST_ID');
    const size = required('FORK_ORDER_SIZE');
    const buy = required('FORK_MAX_BUY_PRICE');
    const sell = required('FORK_MIN_SELL_PRICE');
    const limit = required('FORK_LIMIT_PRICE');
    const modified = required('FORK_MODIFIED_LIMIT_PRICE');
    const funding = BigInt(required('FORK_FUNDING_AMOUNT'));
    const margin = BigInt(required('FORK_MARGIN_AMOUNT'));
    assert.ok(funding > margin && margin > 0n);
    const port = await freePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    const anvil = spawn(
      'anvil',
      [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--fork-url',
        forkUrl,
        '--fork-block-number',
        block,
        '--silent',
      ],
      { stdio: 'ignore' },
    );
    let startupError: Error | undefined;
    anvil.on('error', (error) => {
      startupError = error;
    });
    t.after(() => {
      anvil.kill('SIGTERM');
    });
    const probe = createPublicClient({
      transport: http(rpcUrl, { retryCount: 0, timeout: 1000 }),
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (startupError || anvil.exitCode !== null)
        throw new Error(
          'Could not start Anvil; check installation, fork RPC and pinned block',
        );
      try {
        await probe.getBlockNumber();
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    assert.ok(ready, 'Local fork failed to start');
    const { publicClient, config, chain } = await connectNetwork(
      network,
      rpcUrl,
    );
    assert.equal(await publicClient.getBlockNumber(), BigInt(block));
    for (const address of Object.values(config.contracts))
      assert.ok(
        (await publicClient.getCode({ address }))?.length,
        `No deployment at ${address}`,
      );
    // This untyped development-RPC helper is deliberately bound to our own loopback node.
    async function localRpc(method: string, params: unknown[]) {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const result = (await response.json()) as {
        error?: { message: string };
        result: unknown;
      };
      if (result.error) throw new Error(`Local fork RPC failed: ${method}`);
      return result.result;
    }
    const snapshot = await localRpc('evm_snapshot', []);
    const key = generatePrivateKey();
    const owner = privateKeyToAccount(key);
    await localRpc('anvil_setBalance', [
      owner.address,
      toHex(parseEther('100')),
    ]);
    await localRpc('anvil_setBalance', [donor, toHex(parseEther('100'))]);
    await localRpc('anvil_impersonateAccount', [donor]);
    const donorWallet = createWalletClient({
      account: donor,
      chain,
      transport: http(rpcUrl),
    });
    const donorBalance = await publicClient.readContract({
      address: config.contracts.settlementToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [donor],
    });
    assert.ok(
      donorBalance >= funding * 2n,
      'Donor needs sufficient tokens at pinned block',
    );
    const fundingHash = await donorWallet.writeContract({
      address: config.contracts.settlementToken,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [owner.address, funding * 2n],
    });
    assert.equal(
      (await publicClient.waitForTransactionReceipt({ hash: fundingHash }))
        .status,
      'success',
    );
    await localRpc('anvil_stopImpersonatingAccount', [donor]);
    // Never pass the operator's PRIVATE_KEY to child examples.
    const env = { ...process.env, RPC_URL: rpcUrl, PRIVATE_KEY: key };
    const hermes = new HermesClient('https://pyth.dourolabs.app/hermes', {
      accessToken: required('PYTH_API_KEY'),
    });
    async function alignForkClock() {
      const update = await hermes.getLatestPriceUpdates([
        config.instruments[instId].pythFeedId,
      ]);
      const publishTime = update.parsed?.[0]?.price.publish_time;
      if (!publishTime)
        throw new Error(
          'Hermes returned no publish time for fork clock alignment',
        );
      const latest = await publicClient.getBlock();
      await localRpc('evm_setNextBlockTimestamp', [
        Math.max(Number(latest.timestamp) + 1, publishTime),
      ]);
      // `eth_call` uses the latest mined block, not the next timestamp. Mine
      // once so simulation and the following submission share this window.
      await localRpc('evm_mine', []);
    }
    async function cli(script: string, type: string, args: string[]) {
      try {
        if (
          script === 'market-order' ||
          (script === 'order-lifecycle' &&
            ['create-limit', 'close'].includes(args[1] ?? '')) ||
          (script === 'portfolio-manage' &&
            ['add-margin', 'reduce-margin'].includes(args[1] ?? ''))
        )
          await alignForkClock();
        return await exec(
          process.execPath,
          [
            '--import',
            'tsx',
            `examples/${script}.ts`,
            '--network',
            network,
            '--portfolio-type',
            type,
            ...args,
            '--execute',
            '--acknowledge-live-risk',
          ],
          {
            cwd: new URL('..', import.meta.url),
            env,
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
          },
        );
      } catch (error) {
        // Keep diagnostics useful without exposing the Pyth key or signed payloads.
        const stderr = String((error as { stderr?: unknown }).stderr ?? '')
          .replaceAll(process.env.PYTH_API_KEY ?? '', '[REDACTED]')
          .replace(/0x[0-9a-fA-F]{130,}/g, '[REDACTED_ORACLE_PAYLOAD]')
          .slice(0, 1800);
        throw new Error(
          `Fork CLI failed: ${script}, ${type}, ${args[0] ?? ''}; ${stderr || 'no child stderr'}`,
          { cause: error },
        );
      }
    }
    for (const type of ['imp', 'cmp'] as const) {
      await t.test(type, async () => {
        await cli('prepare-portfolio', type, ['--fund', funding.toString()]);
        const portfolio = (await publicClient.readContract({
          address: config.contracts.portfolioFactory,
          abi: abi('PortfolioFactory'),
          functionName: 'userPortfolio',
          args: [owner.address, type === 'imp' ? 1 : 2],
        })) as Address;
        assert.notEqual(portfolio, zeroAddress);
        const state = () =>
          readPortfolio(publicClient, config, portfolio, type, BigInt(instId));
        assert.equal((await state()).balance, funding);
        const leverageRun = await cli('portfolio-manage', type, [
          '--action',
          'leverage',
          '--inst-id',
          instId,
          '--leverage',
          '2',
        ]);
        assert.equal(
          (await state()).leverage,
          2n,
          `Leverage write did not persist: ${leverageRun.stdout.slice(-600)}`,
        );
        await cli('order-lifecycle', type, [
          '--action',
          'create-limit',
          '--inst-id',
          instId,
          '--side',
          'long',
          '--size',
          size,
          '--limit-price',
          limit,
          '--post-only',
        ]);
        const pending = (await state()).pendingOrderIds;
        assert.equal(pending.length, 1);
        await cli('order-lifecycle', type, [
          '--action',
          'modify-limit',
          '--inst-id',
          instId,
          '--order-id',
          String(pending[0]),
          '--size',
          size,
          '--limit-price',
          modified,
        ]);
        const modifiedState = await state();
        assert.equal(modifiedState.pendingOrderIds.length, 1);
        const modifiedOrder = modifiedState.pendingOrders[0] as {
          limit: { limitPrice: bigint };
          header: { size: bigint };
        };
        assert.equal(modifiedOrder.limit.limitPrice, BigInt(modified));
        assert.equal(modifiedOrder.header.size, BigInt(size));
        const id = modifiedState.pendingOrderIds[0];
        await cli('order-lifecycle', type, [
          '--action',
          'cancel',
          '--inst-id',
          instId,
          '--order-id',
          String(id),
        ]);
        assert.equal((await state()).pendingOrderIds.length, 0);
        await cli('market-order', type, [
          '--inst-id',
          instId,
          '--side',
          'long',
          '--size',
          size,
          '--slippage-limit',
          buy,
        ]);
        const opened = await state();
        assert.equal(opened.position.posState, 1);
        assert.equal(opened.position.posSize, BigInt(size));
        if (type === 'imp') {
          await cli('portfolio-manage', type, [
            '--action',
            'add-margin',
            '--inst-id',
            instId,
            '--amount',
            String(margin),
          ]);
          const added = await state();
          assert.ok(
            BigInt(added.frozenBalance as bigint) >
              BigInt(opened.frozenBalance as bigint),
          );
          await cli('portfolio-manage', type, [
            '--action',
            'reduce-margin',
            '--inst-id',
            instId,
            '--amount',
            String(margin),
          ]);
          assert.ok(
            ((await state()).frozenBalance as bigint) <
              (added.frozenBalance as bigint),
          );
        }
        await cli('order-lifecycle', type, [
          '--action',
          'close',
          '--inst-id',
          instId,
          '--slippage-limit',
          sell,
        ]);
        const closed = await state();
        assert.notEqual(closed.position.posState, 1);
        assert.equal(closed.pendingOrderIds.length, 0);
        const amount = closed.availableBalance as bigint;
        assert.ok(amount > 0n);
        const beforeWallet = await publicClient.readContract({
          address: config.contracts.settlementToken,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [owner.address],
        });
        await cli('portfolio-manage', type, [
          '--action',
          'withdraw',
          '--inst-id',
          instId,
          '--amount',
          String(amount),
        ]);
        const afterWallet = await publicClient.readContract({
          address: config.contracts.settlementToken,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [owner.address],
        });
        assert.equal(afterWallet - beforeWallet, amount);
        assert.equal((await state()).availableBalance, 0n);
      });
    }
    assert.equal(await localRpc('evm_revert', [snapshot]), true);
  },
);
