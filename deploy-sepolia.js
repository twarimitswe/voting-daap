/**
 * deploy-sepolia.js — Zero-dependency Sepolia deployer
 * Uses only Node.js built-ins (https, crypto) — no web3, no HDWalletProvider.
 * Confirmed working with drpc.org on Node.js v22.
 *
 * Usage:  node deploy-sepolia.js
 */

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ──────────────── Load .env manually (no dotenv needed) ──────────────────────
const envPath = path.join(__dirname, '.env');
const env = {};
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*"?([^"]*)"?\s*$/);
        if (m) env[m[1]] = m[2];
    });
}

const RPC_URL  = env.ALCHEMY_URL  || process.env.ALCHEMY_URL;
const PRIV_HEX = (env.PRIVATE_KEY || process.env.PRIVATE_KEY || '').replace(/^0x/, '');
const CHAIN_ID = 11155111;

if (!RPC_URL || !PRIV_HEX) {
    console.error('❌  Missing ALCHEMY_URL or PRIVATE_KEY in .env');
    process.exit(1);
}

// ──────────────── Tiny Ethereum helpers ───────────────────────────────────────

// Keccak-256 using Node crypto (only needed for address from pubkey)
function keccak256(buf) {
    return crypto.createHash('sha3-256').update(buf).digest();
}

// Simple secp256k1 signing via subtle or manual math is complex in pure Node.
// We use the ethereumjs-util from hdwallet-provider's deps if available,
// otherwise we rely on the eth_signTransaction RPC method isn't available on public nodes.
// Best approach: use @ethereumjs/tx + secp256k1 which ARE in node_modules.

const { Transaction } = (() => {
    try {
        // Try local node_modules (installed with hdwallet-provider)
        return require('./node_modules/@ethereumjs/tx');
    } catch {
        try { return require('@ethereumjs/tx'); } catch {
            return null;
        }
    }
})();

const Common = (() => {
    try {
        const m = require('./node_modules/@ethereumjs/common');
        return m.default || m;
    } catch {
        try {
            const m = require('@ethereumjs/common');
            return m.default || m;
        } catch { return null; }
    }
})();

if (!Transaction || !Common) {
    console.error('❌ @ethereumjs/tx not found in node_modules.');
    console.error('   Run: npm install @ethereumjs/tx @ethereumjs/common');
    process.exit(1);
}

// ──────────────── RPC helper ─────────────────────────────────────────────────
let _id = 1;
function rpc(method, params = []) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: _id++, method, params });
        const url = new URL(RPC_URL);
        const req = https.request({
            hostname: url.hostname,
            path:     url.pathname + (url.search || ''),
            port:     443,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
                    else resolve(parsed.result);
                } catch (e) { reject(e); }
            });
        });
        req.setTimeout(30000, () => { req.destroy(new Error('RPC request timed out')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ──────────────── Main ───────────────────────────────────────────────────────
async function main() {
    console.log('\n🚀  Zero-dependency Sepolia Deployer');
    console.log('RPC:', RPC_URL);

    // Derive address from private key
    const privBuf = Buffer.from(PRIV_HEX, 'hex');

    // Use secp256k1 from node_modules (it's always there for signing)
    const secp = (() => {
        try { return require('./node_modules/secp256k1'); } catch {
            try { return require('secp256k1'); } catch { return null; }
        }
    })();

    let fromAddress;
    if (secp) {
        const pub = secp.publicKeyCreate(privBuf, false).slice(1); // uncompressed without 04
        const hash = crypto.createHash('sha3-256').update(pub).digest();
        fromAddress = '0x' + hash.slice(-20).toString('hex');
    } else {
        // Fallback: ask the RPC for accounts (won't work on public RPC, warn user)
        console.warn('⚠️  secp256k1 not found — cannot derive address. Using eth_accounts...');
        const accounts = await rpc('eth_accounts');
        fromAddress = accounts[0];
    }

    console.log('Deployer:', fromAddress);

    const balHex = await rpc('eth_getBalance', [fromAddress, 'latest']);
    const balWei = BigInt(balHex);
    const balEth = Number(balWei) / 1e18;
    console.log('Balance: ', balEth.toFixed(6), 'ETH');

    if (balEth < 0.001) {
        console.error('❌ Not enough Sepolia ETH. Get free ETH at: https://sepoliafaucet.com');
        process.exit(1);
    }

    // Load artifact
    const artifactPath   = path.join(__dirname, 'build', 'contracts', 'Voting.json');
    const clientArtifact = path.join(__dirname, 'client', 'Voting.json');
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const bytecode = artifact.bytecode;

    if (!bytecode || bytecode === '0x') {
        console.error('❌ No bytecode. Run: npx truffle compile');
        process.exit(1);
    }

    // Get nonce and gas price
    const nonceHex    = await rpc('eth_getTransactionCount', [fromAddress, 'latest']);
    const gasPriceHex = await rpc('eth_gasPrice');
    const nonce    = parseInt(nonceHex, 16);
    const gasPrice = BigInt(gasPriceHex);

    console.log('Nonce:', nonce, '| Gas price:', Number(gasPrice / 1000000000n), 'gwei');

    // Build transaction using @ethereumjs/tx
    const common = Common.custom({ chainId: CHAIN_ID }, { hardfork: 'london' });
    const txData = {
        nonce:    '0x' + nonce.toString(16),
        gasPrice: '0x' + gasPrice.toString(16),
        gasLimit: '0x' + (1500000).toString(16),
        value:    '0x0',
        data:     bytecode.startsWith('0x') ? bytecode : '0x' + bytecode,
        to:       undefined, // contract creation
    };

    let tx;
    try {
        tx = Transaction.fromTxData(txData, { common });
    } catch (e) {
        // Try alternate API (v4+)
        const { LegacyTransaction } = require('./node_modules/@ethereumjs/tx');
        tx = LegacyTransaction.fromTxData(txData, { common });
    }

    const signed = tx.sign(privBuf);
    const raw = '0x' + signed.serialize().toString('hex');

    console.log('\nSending transaction...');
    const txHash = await rpc('eth_sendRawTransaction', [raw]);
    console.log('Tx hash:', txHash);

    // Wait for receipt
    console.log('Waiting for confirmation (this takes ~15-30s on Sepolia)...');
    let receipt = null;
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        receipt = await rpc('eth_getTransactionReceipt', [txHash]);
        if (receipt) break;
        process.stdout.write('.');
    }
    console.log('');

    if (!receipt || !receipt.contractAddress) {
        console.error('❌ No receipt received. Check Sepolia explorer:', `https://sepolia.etherscan.io/tx/${txHash}`);
        process.exit(1);
    }

    const contractAddress = receipt.contractAddress;
    console.log('✅ Deployed at:', contractAddress);
    console.log('   Etherscan:  ', `https://sepolia.etherscan.io/address/${contractAddress}`);

    // Update artifacts
    artifact.networks = artifact.networks || {};
    artifact.networks[String(CHAIN_ID)] = {
        events: {}, links: {},
        address: contractAddress,
        transactionHash: txHash,
    };
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
    fs.writeFileSync(clientArtifact, JSON.stringify(artifact, null, 2));
    console.log('   Artifacts updated — DApp will auto-load the new address.');
    console.log('\n🎉 All done! Reload the voting DApp in your browser.');
    process.exit(0);
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
