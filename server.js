/**
 * BSV QUANTUM VAULT - Production Server 
 * 
 * 
 * 
 * ENDPOINTS:
 * - GET  /api/health
 * - GET  /api/create
 * - POST /api/balance
 * - POST /api/verify
 * - POST /api/generate-funding-address
 * - POST /api/check-funding              
 * - POST /api/send-from-funding
 * - POST /api/deposit-to-vault           
 * - POST /api/sweep
 * - GET  /api/price
 * - GET  /api/tx/:txid
 * 
 * @version 1
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');

// Winternitz module
const wots = require('./winternitz');

// secp256k1 for covenant signing
let secp256k1 = null;
try {
    secp256k1 = require('secp256k1');
    console.log('✅ secp256k1 library loaded');
} catch (e) {
    console.log('⚠️ secp256k1 not found - run: npm install secp256k1');
}

// BSV Library
let bsv = null;
try {
    bsv = require('bsv');
    console.log('✅ BSV library loaded');
} catch (e) {
    console.log('⚠️ BSV library not found - run: npm install bsv');
}

const app = express();
const PORT = process.env.PORT || 4000;

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    WOC_BASE: 'https://api.whatsonchain.com/v1/bsv/main',
    TAAL_URL: 'https://api.taal.com/api/v1/broadcast',
    TAAL_KEYS: process.env.TAAL_API_KEYS?.split(',') || [
        'mainnet_API_KEYS_HERE',
        'mainnet_API_KEYS_HERE'
    ],
    GORILLA_URL: 'https://mapi.gorillapool.io/mapi/tx',
    FEE_RATE_STANDARD: 1,
    FEE_RATE_PRIORITY: 2,
    MIN_OUTPUT: 546,
    MIN_SWEEP: 2000,
    API_TIMEOUT: 45000
};

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest();
}

function hash256(data) {
    return sha256(sha256(data));
}

function hash160(data) {
    return crypto.createHash('ripemd160').update(sha256(data)).digest();
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer) {
    let carry, digits = [0];
    for (let i = 0; i < buffer.length; i++) {
        carry = buffer[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let str = '';
    for (let k = 0; buffer[k] === 0 && k < buffer.length - 1; k++) str += BASE58_ALPHABET[0];
    for (let q = digits.length - 1; q >= 0; q--) str += BASE58_ALPHABET[digits[q]];
    return str;
}

function base58Decode(str) {
    const bytes = [0];
    for (let i = 0; i < str.length; i++) {
        let value = BASE58_ALPHABET.indexOf(str[i]);
        if (value === -1) throw new Error('Invalid base58 character');
        for (let j = 0; j < bytes.length; j++) {
            value += bytes[j] * 58;
            bytes[j] = value & 0xff;
            value >>= 8;
        }
        while (value > 0) {
            bytes.push(value & 0xff);
            value >>= 8;
        }
    }
    for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
    return Buffer.from(bytes.reverse());
}

function base58CheckDecode(address) {
    const decoded = base58Decode(address);
    const data = decoded.slice(0, -4);
    const checksum = decoded.slice(-4);
    if (!checksum.equals(hash256(data).slice(0, 4))) {
        throw new Error('Invalid checksum');
    }
    return { version: data[0], payload: data.slice(1) };
}

function encodeVarInt(n) {
    if (n < 0xfd) {
        return Buffer.from([n]);
    } else if (n <= 0xffff) {
        const buf = Buffer.alloc(3);
        buf[0] = 0xfd;
        buf.writeUInt16LE(n, 1);
        return buf;
    } else if (n <= 0xffffffff) {
        const buf = Buffer.alloc(5);
        buf[0] = 0xfe;
        buf.writeUInt32LE(n, 1);
        return buf;
    } else {
        const buf = Buffer.alloc(9);
        buf[0] = 0xff;
        buf.writeBigUInt64LE(BigInt(n), 1);
        return buf;
    }
}

function encodePushData(data) {
    const len = data.length;
    if (len <= 75) {
        return Buffer.concat([Buffer.from([len]), data]);
    } else if (len <= 255) {
        return Buffer.concat([Buffer.from([0x4c, len]), data]);
    } else if (len <= 65535) {
        const lenBuf = Buffer.alloc(2);
        lenBuf.writeUInt16LE(len);
        return Buffer.concat([Buffer.from([0x4d]), lenBuf, data]);
    } else {
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(len);
        return Buffer.concat([Buffer.from([0x4e]), lenBuf, data]);
    }
}

function buildOutputScript(address) {
    const decoded = base58CheckDecode(address);
    const pubKeyHash = decoded.payload;
    return Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]),
        pubKeyHash,
        Buffer.from([0x88, 0xac])
    ]);
}

function serializeOutputs(outputs) {
    const parts = [];
    for (const output of outputs) {
        const valueBuf = Buffer.alloc(8);
        valueBuf.writeBigUInt64LE(BigInt(output.value));
        parts.push(valueBuf);
        parts.push(encodeVarInt(output.script.length));
        parts.push(output.script);
    }
    return Buffer.concat(parts);
}

// =============================================================================
// NETWORK FUNCTIONS
// =============================================================================

/**
 * Get balance for an address
 */
async function getBalance(address) {
    try {
        const response = await axios.get(
            `${CONFIG.WOC_BASE}/address/${address}/balance`,
            { timeout: CONFIG.API_TIMEOUT }
        );
        return {
            confirmed: response.data.confirmed || 0,
            unconfirmed: response.data.unconfirmed || 0,
            total: (response.data.confirmed || 0) + (response.data.unconfirmed || 0)
        };
    } catch (error) {
        console.error('Balance fetch error:', error.message);
        return { confirmed: 0, unconfirmed: 0, total: 0 };
    }
}

/**
 * Get UTXOs for an address
 */
async function getUTXOs(address) {
    try {
        const response = await axios.get(
            `${CONFIG.WOC_BASE}/address/${address}/unspent`,
            { timeout: CONFIG.API_TIMEOUT }
        );
        return response.data || [];
    } catch (error) {
        console.error('UTXO fetch error:', error.message);
        return [];
    }
}

async function getUTXOsByScriptHash(scriptHash) {
    try {
        const response = await axios.get(
            `${CONFIG.WOC_BASE}/script/${scriptHash}/unspent`,
            { timeout: CONFIG.API_TIMEOUT }
        );
        return response.data || [];
    } catch (error) {
        console.error('Script UTXO fetch error:', error.message);
        return [];
    }
}

async function getBSVPrice() {
    try {
        const response = await axios.get(
            `${CONFIG.WOC_BASE}/exchangerate`,
            { timeout: 5000 }
        );
        return response.data.rate || 0;
    } catch {
        return 0;
    }
}

async function getTransaction(txid) {
    try {
        const response = await axios.get(
            `${CONFIG.WOC_BASE}/tx/${txid}`,
            { timeout: CONFIG.API_TIMEOUT }
        );
        return response.data;
    } catch (error) {
        throw new Error('Transaction not found');
    }
}

async function broadcastTransaction(rawHex) {
    const errors = [];
    
    // Try TAAL first
    for (const key of CONFIG.TAAL_KEYS) {
        if (!key || key.includes('PLACEHOLDER')) continue;
        try {
            console.log('Broadcasting via TAAL...');
            const response = await axios.post(
                CONFIG.TAAL_URL,
                { rawTx: rawHex },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${key}`
                    },
                    timeout: CONFIG.API_TIMEOUT
                }
            );
            if (response.status === 200 && response.data) {
                const txid = response.data.txid || response.data.result || response.data;
                return { success: true, txid: txid.toString().replace(/"/g, ''), via: 'TAAL' };
            }
        } catch (e) {
            errors.push(`TAAL: ${e.response?.data?.message || e.message}`);
        }
    }
    
    // Try GorillaPool
    try {
        console.log('Broadcasting via GorillaPool...');
        const response = await axios.post(
            CONFIG.GORILLA_URL,
            { rawtx: rawHex },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: CONFIG.API_TIMEOUT
            }
        );
        if (response.data?.returnResult === 'success' || response.data?.txid) {
            const txid = response.data.txid || hash256(Buffer.from(rawHex, 'hex')).reverse().toString('hex');
            return { success: true, txid, via: 'GorillaPool' };
        }
    } catch (e) {
        errors.push(`GorillaPool: ${e.response?.data?.message || e.message}`);
    }
    
    // Try WhatsOnChain
    try {
        console.log('Broadcasting via WhatsOnChain...');
        const response = await axios.post(
            `${CONFIG.WOC_BASE}/tx/raw`,
            { txhex: rawHex },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: CONFIG.API_TIMEOUT
            }
        );
        const txid = response.data.toString().replace(/"/g, '').trim();
        return { success: true, txid, via: 'WhatsOnChain' };
    } catch (e) {
        errors.push(`WhatsOnChain: ${e.response?.data || e.message}`);
    }
    
    return {
        success: false,
        error: 'All broadcast attempts failed: ' + errors.join('; ')
    };
}

// =============================================================================
// ECDSA SIGNING FOR COVENANT
// =============================================================================

function signWithCovenantKey(privateKey, sighash) {
    if (!secp256k1) {
        throw new Error('secp256k1 library not available');
    }
    const sigObj = secp256k1.ecdsaSign(sighash, privateKey);
    return ecdsaToDER(sigObj.signature);
}

function ecdsaToDER(signature) {
    let r = Buffer.from(signature.slice(0, 32));
    let s = Buffer.from(signature.slice(32, 64));
    
    const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    const halfN = N / 2n;
    const sBigInt = BigInt('0x' + s.toString('hex'));
    
    if (sBigInt > halfN) {
        const newS = N - sBigInt;
        let hex = newS.toString(16);
        if (hex.length % 2) hex = '0' + hex;
        s = Buffer.from(hex, 'hex');
    }
    
    while (r.length > 1 && r[0] === 0 && r[1] < 0x80) r = r.slice(1);
    if (r[0] >= 0x80) r = Buffer.concat([Buffer.from([0x00]), r]);
    
    while (s.length > 1 && s[0] === 0 && s[1] < 0x80) s = s.slice(1);
    if (s[0] >= 0x80) s = Buffer.concat([Buffer.from([0x00]), s]);
    
    const totalLen = 4 + r.length + s.length;
    
    return Buffer.concat([
        Buffer.from([0x30, totalLen]),
        Buffer.from([0x02, r.length]), r,
        Buffer.from([0x02, s.length]), s
    ]);
}

// =============================================================================
// TRANSACTION BUILDING
// =============================================================================

function buildRawTransaction(utxos, lockingScript, unlockingScript, outputScript, outputValue, nLockTime = 0) {
    const parts = [];
    
    const version = Buffer.alloc(4);
    version.writeUInt32LE(1);
    parts.push(version);
    
    parts.push(encodeVarInt(utxos.length));
    
    for (const utxo of utxos) {
        const txidField = utxo.tx_hash || utxo.txid;
        parts.push(Buffer.from(txidField, 'hex').reverse());
        
        const vout = Buffer.alloc(4);
        vout.writeUInt32LE(utxo.tx_pos !== undefined ? utxo.tx_pos : utxo.vout);
        parts.push(vout);
        
        const scriptBuf = Buffer.isBuffer(unlockingScript) ? unlockingScript : Buffer.from(unlockingScript, 'hex');
        parts.push(encodeVarInt(scriptBuf.length));
        parts.push(scriptBuf);
        
        if (nLockTime > 0) {
            parts.push(Buffer.from([0xfe, 0xff, 0xff, 0xff]));
        } else {
            parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
        }
    }
    
    parts.push(Buffer.from([0x01]));
    
    const valueBuf = Buffer.alloc(8);
    valueBuf.writeBigUInt64LE(BigInt(outputValue));
    parts.push(valueBuf);
    
    const outScriptBuf = Buffer.isBuffer(outputScript) ? outputScript : Buffer.from(outputScript, 'hex');
    parts.push(encodeVarInt(outScriptBuf.length));
    parts.push(outScriptBuf);
    
    const locktime = Buffer.alloc(4);
    locktime.writeUInt32LE(nLockTime);
    parts.push(locktime);
    
    return Buffer.concat(parts);
}

/**
 * Build deposit transaction from P2PKH to quantum vault (bare script)
 */
function buildDepositTransaction(utxos, privateKey, pubKeyHashHex, lockingScript, outputValue) {
    if (!bsv) throw new Error('BSV library not installed');
    
    // Handle both Raw Buffer AND pre-configured PrivateKey objects
    let bsvPrivKey;
    if (privateKey instanceof bsv.PrivateKey) {
        bsvPrivKey = privateKey;
    } else {
        const privBuf = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey, 'hex');
        bsvPrivKey = new bsv.PrivateKey(privBuf, 'livenet');
    }

    const bsvAddress = bsvPrivKey.toAddress();
    const lockScript = Buffer.isBuffer(lockingScript) ? lockingScript : Buffer.from(lockingScript, 'hex');
    
    console.log('🔑 BSV Library Signing:');
    console.log('   Address:', bsvAddress.toString());
    
    const tx = new bsv.Transaction();
    
    for (const utxo of utxos) {
        tx.from({
            txId: utxo.tx_hash,
            outputIndex: utxo.tx_pos,
            script: bsv.Script.buildPublicKeyHashOut(bsvAddress),
            satoshis: utxo.value
        });
    }
    
    tx.addOutput(new bsv.Transaction.Output({
        script: bsv.Script.fromBuffer(lockScript),
        satoshis: outputValue
    }));
    
    tx.sign(bsvPrivKey);
    
    return Buffer.from(tx.serialize(), 'hex');
}

/**
 * Build WOTS-16 sweep transaction WITH COVENANT
 */
async function buildWOTS16CovenantTransaction(vault, utxos, destinationAddress, feeRate = 1) {
    const secret = JSON.parse(Buffer.from(vault.secret, 'base64').toString());
    
    if (!secret.wots16) {
        throw new Error('Vault does not have WOTS-16 keys');
    }
    
    const wots16Keypair = {
        privateScalars: secret.wots16.privateScalars.map(hex => Buffer.from(hex, 'hex')),
        publicCommitments: secret.wots16.publicCommitments.map(hex => Buffer.from(hex, 'hex')),
        publicKeyHash: Buffer.from(secret.wots16.publicKeyHash, 'hex'),
        params: secret.wots16.params
    };
    
    const covenantPrivKey = wots.getCovenantPrivateKey();
    const totalInput = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
    
    const decoded = base58CheckDecode(destinationAddress);
    const destPubKeyHash = decoded.payload;
    
    const outputScript = Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]),
        destPubKeyHash,
        Buffer.from([0x88, 0xac])
    ]);
    
    const lockingScript = Buffer.from(secret.lockingScript, 'hex');
    
    const estimatedUnlockSize = 2312 + 73 + lockingScript.length + 160;
    const estimatedTxSize = 10 + 41 + estimatedUnlockSize + 34;
    const fee = Math.ceil(estimatedTxSize * feeRate);
    
    const outputValue = totalInput - fee;
    if (outputValue <= 546) {
        throw new Error(`Output value too low: ${outputValue} sats`);
    }
    
    const outputs = [{ value: outputValue, script: outputScript }];
    const outputsBuffer = serializeOutputs(outputs);
    const hashOutputs = hash256(outputsBuffer);
    
    const wots16Signature = wots.signWOTS16(wots16Keypair, hashOutputs);
    
    const utxo = utxos[0];
    const txidField = utxo.tx_hash || utxo.txid;
    const voutField = utxo.tx_pos !== undefined ? utxo.tx_pos : utxo.vout;
    
    const prevTxId = Buffer.from(txidField, 'hex').reverse();
    const prevVout = Buffer.alloc(4);
    prevVout.writeUInt32LE(voutField);
    
    const outpoint = Buffer.concat([prevTxId, prevVout]);
    const hashPrevouts = hash256(outpoint);
    
    const sequence = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    const hashSequence = hash256(sequence);
    
    const scriptCode = lockingScript;
    const scriptCodeLen = encodeVarInt(scriptCode.length);
    
    const valueBuf = Buffer.alloc(8);
    valueBuf.writeBigUInt64LE(BigInt(utxo.value));
    
    const nLocktime = Buffer.alloc(4);
    nLocktime.writeUInt32LE(0);
    
    const sighashType = Buffer.alloc(4);
    sighashType.writeUInt32LE(0x41);
    
    const nVersion = Buffer.alloc(4);
    nVersion.writeUInt32LE(1);
    
    const preimage = Buffer.concat([
        nVersion, hashPrevouts, hashSequence, outpoint,
        scriptCodeLen, scriptCode,
        valueBuf, sequence, hashOutputs, nLocktime, sighashType
    ]);
    
    const sighash = hash256(preimage);
    const ecdsaSignature = signWithCovenantKey(covenantPrivKey, sighash);
    
    const unlockParts = [];
    unlockParts.push(encodePushData(preimage));
    
    const ecdsaSigWithType = Buffer.concat([ecdsaSignature, Buffer.from([0x41])]);
    unlockParts.push(encodePushData(ecdsaSigWithType));
    
    for (let i = wots16Signature.chunks.length - 1; i >= 0; i--) {
        const chunk = wots16Signature.chunks[i];
        
        if (chunk.remaining === 0) {
            unlockParts.push(Buffer.from([0x00]));
        } else if (chunk.remaining <= 16) {
            unlockParts.push(Buffer.from([0x50 + chunk.remaining]));
        } else {
            unlockParts.push(Buffer.from([0x01, chunk.remaining]));
        }
        
        unlockParts.push(Buffer.from([0x20]));
        unlockParts.push(chunk.value);
    }
    
    const unlockingScript = Buffer.concat(unlockParts);
    
    const txParts = [];
    txParts.push(nVersion);
    txParts.push(Buffer.from([0x01]));
    txParts.push(prevTxId);
    txParts.push(prevVout);
    txParts.push(encodeVarInt(unlockingScript.length));
    txParts.push(unlockingScript);
    txParts.push(sequence);
    txParts.push(Buffer.from([0x01]));
    
    const outputValueBuf = Buffer.alloc(8);
    outputValueBuf.writeBigUInt64LE(BigInt(outputValue));
    txParts.push(outputValueBuf);
    txParts.push(encodeVarInt(outputScript.length));
    txParts.push(outputScript);
    txParts.push(nLocktime);
    
    const rawTx = Buffer.concat(txParts);
    
    return {
        rawTx: rawTx.toString('hex'),
        txSize: rawTx.length,
        fee,
        outputValue,
        inputValue: totalInput,
        hashOutputs: hashOutputs.toString('hex')
    };
}

/**
 * Build standard sweep transaction (non-WOTS-16)
 */
function buildStandardSweepTransaction(utxos, vault, toAddress, feeRate = 1) {
    let totalInput = 0;
    utxos.forEach(u => totalInput += u.value);
    
    const outputScript = buildOutputScript(toAddress);
    const unlockData = wots.createUnlockingData(vault);
    
    const scriptSigSize = 3 + unlockData.preimageSize;
    const inputSize = 32 + 4 + 3 + scriptSigSize + 4;
    const outputSize = 8 + 1 + 25;
    const txOverhead = 4 + 1 + 1 + 4;
    const estimatedSize = txOverhead + (utxos.length * inputSize) + outputSize;
    const fee = Math.ceil(estimatedSize * feeRate);
    const outputValue = totalInput - fee;
    
    if (outputValue < CONFIG.MIN_OUTPUT) {
        throw new Error(`Insufficient funds: ${totalInput} sats - ${fee} fee = ${outputValue}`);
    }
    
    const rawTx = buildRawTransaction(
        utxos,
        vault.lockingScript,
        unlockData.scriptSig,
        outputScript,
        outputValue
    );
    
    return {
        rawHex: rawTx.toString('hex'),
        txid: hash256(rawTx).reverse().toString('hex'),
        fee,
        outputValue,
        inputValue: totalInput,
        size: rawTx.length,
        inputs: utxos.length
    };
}

// =============================================================================
// API ROUTES
// =============================================================================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        version: '4.6.0',
        timestamp: new Date().toISOString(),
        features: { wots16: true, covenant: true, frontRunImmune: true }
    });
});

/**
 * GET /api/create - Create vault
 */
app.get('/api/create', async (req, res) => {
    try {
        const { security, lockTime, lockType } = req.query;
        
        console.log(`\n📦 Creating vault: ${security || 'standard'} security`);
        
        const vault = wots.createQuantumVault({
            securityLevel: security || 'standard',
            lockTime: parseInt(lockTime) || 0,
            lockType: lockType || 'blocks',
            network: 'mainnet'
        });
        
        console.log(`   Vault ID: ${vault.vaultId}`);
        console.log(`   Script hash: ${vault.scriptHash}`);
        console.log(`   Front-run immune: ${vault.frontRunImmune ? 'YES ✓' : 'No'}`);
        
        res.json({
            success: true,
            vaultId: vault.vaultId,
            scriptHash: vault.scriptHash,
            wocScriptHash: vault.wocScriptHash,
            lockingScript: vault.lockingScript,
            lockingScriptASM: vault.lockingScriptASM || 'Verification script',
            secret: vault.secret,
            security: {
                level: vault.securityLevel,
                signatureType: vault.quantumImmuneSpend ? 'WOTS-16 (Quantum-Safe)' : 'Winternitz OTS',
                keyEntropy: vault.quantumImmuneSpend ? '2176 bytes' : '1024 bytes',
                frontRunImmune: vault.frontRunImmune,
                quantumSafe: vault.quantumImmuneSpend
            }
        });
        
    } catch (error) {
        console.error('Vault creation error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/balance - Check vault balance
 */
app.post('/api/balance', async (req, res) => {
    try {
        const { secret } = req.body;
        
        if (!secret) {
            return res.status(400).json({ success: false, error: 'Secret required' });
        }
        
        const vault = wots.restoreVaultFromSecret(secret);
        
        console.log(`\n💰 Checking balance for: ${vault.vaultId}`);
        
        const utxos = await getUTXOsByScriptHash(vault.wocScriptHash);
        
        let confirmed = 0;
        let unconfirmed = 0;
        
        utxos.forEach(u => {
            if (u.height > 0) {
                confirmed += u.value;
            } else {
                unconfirmed += u.value;
            }
        });
        
        const total = confirmed + unconfirmed;
        const bsvPrice = await getBSVPrice();
        
        const canSweep = total >= CONFIG.MIN_SWEEP;
        const sweepNote = total < CONFIG.MIN_SWEEP 
            ? `Need at least ${CONFIG.MIN_SWEEP} sats` 
            : 'Ready to sweep';
        
        res.json({
            success: true,
            vaultId: vault.vaultId,
            scriptHash: vault.wocScriptHash,
            balance: {
                confirmed,
                unconfirmed,
                satoshis: total,
                bsv: (total / 100000000).toFixed(8),
                usd: bsvPrice > 0 ? (total / 100000000 * bsvPrice).toFixed(2) : '0.00'
            },
            utxoCount: utxos.length,
            price: bsvPrice.toFixed(2),
            canSweep,
            sweepNote
        });
        
    } catch (error) {
        console.error('Balance check error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/verify - Verify vault secret (returns 'derived' for frontend)
 */
app.post('/api/verify', (req, res) => {
    try {
        const { secret } = req.body;
        
        if (!secret) {
            return res.status(400).json({ success: false, error: 'Secret required' });
        }
        
        console.log('\n🔍 Verifying vault secret...');
        
        const vault = wots.restoreVaultFromSecret(secret);
        
        console.log(`   ✅ Vault ID: ${vault.vaultId}`);
        
        // CRITICAL: Frontend expects 'derived' field!
        res.json({
            success: true,
            matches: { valid: true },
            derived: {
                vaultId: vault.vaultId,
                scriptHash: vault.scriptHash,
                wocScriptHash: vault.wocScriptHash,
                securityLevel: vault.securityLevel,
                scriptType: vault.scriptType,
                lockingScriptHex: vault.lockingScriptHex
            }
        });
        
    } catch (error) {
        console.error('Verify error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/generate-funding-address - Generate a funding address
 */
app.post('/api/generate-funding-address', async (req, res) => {
    try {
        console.log('\n🔑 Generating funding address...');
        
        let address, wif, privateKeyHex, publicKeyHex, publicKeyHash;
        
        if (bsv) {
            const bsvPrivKey = new bsv.PrivateKey();
            const bsvPubKey = bsvPrivKey.toPublicKey();
            const bsvAddress = bsvPrivKey.toAddress();
            
            wif = bsvPrivKey.toWIF();
            privateKeyHex = bsvPrivKey.bn.toBuffer({size: 32}).toString('hex');
            publicKeyHex = bsvPubKey.toString();
            publicKeyHash = bsv.crypto.Hash.sha256ripemd160(bsvPubKey.toBuffer()).toString('hex');
            address = bsvAddress.toString();
        } else {
            const privateKey = crypto.randomBytes(32);
            const ecdh = crypto.createECDH('secp256k1');
            ecdh.setPrivateKey(privateKey);
            const publicKey = ecdh.getPublicKey(null, 'compressed');
            
            const pubKeyHashBuf = hash160(publicKey);
            const versionedPayload = Buffer.concat([Buffer.from([0x00]), pubKeyHashBuf]);
            const checksum = hash256(versionedPayload).slice(0, 4);
            address = base58Encode(Buffer.concat([versionedPayload, checksum]));
            
            const wifPayload = Buffer.concat([Buffer.from([0x80]), privateKey, Buffer.from([0x01])]);
            const wifChecksum = hash256(wifPayload).slice(0, 4);
            wif = base58Encode(Buffer.concat([wifPayload, wifChecksum]));
            
            privateKeyHex = privateKey.toString('hex');
            publicKeyHex = publicKey.toString('hex');
            publicKeyHash = pubKeyHashBuf.toString('hex');
        }
        
        const fundingData = {
            address,
            privateKeyWIF: wif,
            privateKeyHex: privateKeyHex,
            publicKeyHash: publicKeyHash,
            publicKeyHex: publicKeyHex,
            created: Date.now(),
            network: 'mainnet'
        };
        
        console.log(`💳 Generated funding address: ${address}`);
        
        res.json({
            success: true,
            fundingAddress: address,
            fundingData: Buffer.from(JSON.stringify(fundingData)).toString('base64'),
            qrData: `bitcoin:${address}`,
            keys: {
                privateKeyWIF: wif,
                privateKeyHex: privateKeyHex,
                publicKeyHex: publicKeyHex,
                publicKeyHash: publicKeyHash
            },
            instructions: {
                step1: 'Scan the QR code or copy the address',
                step2: 'Send BSV from any wallet to this address',
                step3: 'Click "Deposit to Vault" once funds arrive',
                note: 'This is a temporary address - funds will be swept to your quantum vault'
            }
        });
        
    } catch (error) {
        console.error('Generate funding address error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/check-funding - Check balance of funding address
 * THIS WAS THE MISSING ENDPOINT!
 */
app.post('/api/check-funding', async (req, res) => {
    try {
        const { fundingData } = req.body;
        
        if (!fundingData) {
            return res.status(400).json({ success: false, error: 'Funding data required' });
        }
        
        // Decode from base64
        const decoded = JSON.parse(Buffer.from(fundingData, 'base64').toString());
        const address = decoded.address;
        
        console.log(`\n💳 Checking funding address: ${address}`);
        
        // Get balance and UTXOs
        const balance = await getBalance(address);
        const utxos = await getUTXOs(address);
        const price = await getBSVPrice();
        
        console.log(`   Balance: ${balance.total} sats (${balance.confirmed} confirmed)`);
        
        res.json({
            success: true,
            address,
            balance: {
                satoshis: balance.total,
                bsv: (balance.total / 100000000).toFixed(8),
                usd: ((balance.total / 100000000) * price).toFixed(2),
                confirmed: balance.confirmed,
                unconfirmed: balance.unconfirmed
            },
            utxoCount: utxos.length,
            readyToDeposit: balance.total >= CONFIG.MIN_SWEEP,
            price: price.toFixed(2)
        });
        
    } catch (error) {
        console.error('Check funding error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/send-from-funding - Send from temporary funding address
 */
app.post('/api/send-from-funding', async (req, res) => {
    try {
        const { fundingData, toAddress } = req.body;
        
        if (!fundingData || !toAddress) {
            return res.status(400).json({ success: false, error: 'Funding data and destination required' });
        }
        
        console.log(`\n📤 Sending from funding address to: ${toAddress}`);
        
        let funding;
        try {
            funding = JSON.parse(Buffer.from(fundingData, 'base64').toString());
        } catch (e) {
            funding = typeof fundingData === 'object' ? fundingData : JSON.parse(fundingData);
        }
        
        const fundingAddress = funding.address;
        const wif = funding.privateKeyWIF || funding.wif;
        const privateKeyHex = funding.privateKeyHex || funding.privateKey;
        
        if (!fundingAddress) {
            return res.status(400).json({ success: false, error: 'Invalid funding data' });
        }
        
        const utxos = await getUTXOs(fundingAddress);
        
        if (utxos.length === 0) {
            return res.status(400).json({ success: false, error: 'No funds at funding address' });
        }
        
        let totalInput = 0;
        utxos.forEach(u => totalInput += u.value);
        
        if (!bsv) {
            return res.status(400).json({ success: false, error: 'BSV library required' });
        }
        
        let privKey;
        if (wif) {
            privKey = bsv.PrivateKey.fromWIF(wif);
        } else if (privateKeyHex) {
            privKey = bsv.PrivateKey.fromHex(privateKeyHex);
        } else {
            return res.status(400).json({ success: false, error: 'No private key in funding data' });
        }
        
        const tx = new bsv.Transaction();
        
        for (const utxo of utxos) {
            tx.from({
                txId: utxo.tx_hash,
                outputIndex: utxo.tx_pos,
                script: bsv.Script.fromAddress(fundingAddress),
                satoshis: utxo.value
            });
        }
        
        const estimatedSize = utxos.length * 148 + 34 + 10;
        const fee = Math.ceil(estimatedSize * CONFIG.FEE_RATE_STANDARD);
        const outputValue = totalInput - fee;
        
        if (outputValue < CONFIG.MIN_OUTPUT) {
            return res.status(400).json({ success: false, error: `Insufficient funds: ${outputValue} sats` });
        }
        
        tx.to(toAddress, outputValue);
        tx.sign(privKey);
        
        const rawHex = tx.serialize();
        const result = await broadcastTransaction(rawHex);
        
        if (result.success) {
            res.json({
                success: true,
                txid: result.txid,
                explorerLink: `https://whatsonchain.com/tx/${result.txid}`,
                details: {
                    amount: outputValue,
                    toAddress,
                    fee,
                    broadcastVia: result.via
                }
            });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
        
    } catch (error) {
        console.error('Send error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/deposit-to-vault - Deposit from funding address to vault
 * FIXED: Accepts vaultSecret parameter as frontend expects
 */
app.post('/api/deposit-to-vault', async (req, res) => {
    try {
        const { fundingData, vaultSecret, vaultLockingScript } = req.body;
        
        if (!fundingData) {
            return res.status(400).json({ success: false, error: 'Funding data required' });
        }
        if (!vaultSecret && !vaultLockingScript) {
            return res.status(400).json({ success: false, error: 'Vault secret or locking script required' });
        }
        
        // Decode funding data
        let funding;
        try {
            funding = JSON.parse(Buffer.from(fundingData, 'base64').toString());
        } catch (e) {
            funding = typeof fundingData === 'object' ? fundingData : JSON.parse(fundingData);
        }
        
        // Get locking script - either from vaultSecret or directly provided
        let lockingScript, vaultId;
        if (vaultSecret) {
            const vault = wots.restoreVaultFromSecret(vaultSecret);
            lockingScript = vault.lockingScriptHex || vault.lockingScript.toString('hex');
            vaultId = vault.vaultId;
            console.log(`\n🔐 Depositing to vault: ${vaultId}`);
        } else {
            lockingScript = vaultLockingScript;
            vaultId = 'direct-script';
            console.log(`\n🔐 Depositing to vault (direct script)`);
        }
        
        // Get private key
        const wif = funding.privateKeyWIF || funding.wif;
        const privateKeyHex = funding.privateKeyHex || funding.privateKey;
        
        if (!bsv) {
            return res.status(400).json({ success: false, error: 'BSV library required' });
        }
        
        let bsvPrivKey;
        if (wif) {
            console.log('🔑 Recovering key from WIF...');
            bsvPrivKey = bsv.PrivateKey.fromWIF(wif);
        } else if (privateKeyHex) {
            console.log('⚠️ No WIF found, trying hex recovery...');
            const rawKeyBuffer = Buffer.from(privateKeyHex, 'hex');
            bsvPrivKey = new bsv.PrivateKey(rawKeyBuffer, 'livenet');
        } else {
            return res.status(400).json({ success: false, error: 'No private key found' });
        }
        
        // Verify address matches
        const derivedAddress = bsvPrivKey.toAddress().toString();
        if (derivedAddress !== funding.address) {
            console.log(`❌ Address mismatch! Derived: ${derivedAddress}, Expected: ${funding.address}`);
            return res.status(400).json({ success: false, error: `Key mismatch: derived ${derivedAddress} but expected ${funding.address}` });
        }
        
        console.log(`✅ Key verified: ${derivedAddress}`);
        
        // Get UTXOs
        const utxos = await getUTXOs(funding.address);
        console.log(`📥 Found ${utxos.length} UTXOs in funding address`);
        
        if (utxos.length === 0) {
            return res.status(400).json({ success: false, error: 'No funds found in funding address' });
        }
        
        let totalInput = 0;
        utxos.forEach(u => totalInput += u.value);
        console.log(`💰 Total available: ${totalInput} satoshis`);
        
        // Calculate fee
        const lockingScriptSize = lockingScript.length / 2;
        const estimatedSize = 10 + (utxos.length * 148) + lockingScriptSize + 9;
        const fee = Math.ceil(estimatedSize * CONFIG.FEE_RATE_STANDARD);
        
        if (totalInput < fee + CONFIG.MIN_OUTPUT) {
            return res.status(400).json({ success: false, error: `Insufficient funds: ${totalInput} sats (need ${fee + CONFIG.MIN_OUTPUT})` });
        }
        
        const outputValue = totalInput - fee;
        
        console.log(`📝 Building deposit transaction:`);
        console.log(`   Input: ${totalInput} sats`);
        console.log(`   Output: ${outputValue} sats (to vault)`);
        console.log(`   Fee: ${fee} sats`);
        
        // Build transaction
        const rawTx = buildDepositTransaction(
            utxos,
            bsvPrivKey,
            funding.publicKeyHash,
            lockingScript,
            outputValue
        );
        
        console.log(`📡 Broadcasting ${rawTx.length} byte transaction...`);
        const result = await broadcastTransaction(rawTx.toString('hex'));
        
        if (result.success) {
            console.log(`✅ Deposit successful: ${result.txid}`);
            res.json({
                success: true,
                txid: result.txid,
                explorerLink: `https://whatsonchain.com/tx/${result.txid}`,
                details: {
                    vaultId: vaultId,
                    toVault: vaultId,
                    amount: outputValue,
                    outputValue: outputValue,
                    fee,
                    fromAddress: funding.address,
                    broadcastVia: result.via
                }
            });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
        
    } catch (error) {
        console.error('Deposit to vault error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/sweep - Sweep all funds from vault
 */
app.post('/api/sweep', async (req, res) => {
    try {
        const { secret, toAddress, feeRate } = req.body;
        
        if (!secret) {
            return res.status(400).json({ success: false, error: 'Vault secret required' });
        }
        if (!toAddress) {
            return res.status(400).json({ success: false, error: 'Destination address required' });
        }
        
        if (!toAddress.startsWith('1')) {
            return res.status(400).json({ success: false, error: 'Destination must be P2PKH (starts with 1)' });
        }
        
        const secretData = JSON.parse(Buffer.from(secret, 'base64').toString());
        const isWOTS16 = secretData.wots16 && secretData.securityLevel === 'ultimate';
        const isCovenant = secretData.scriptType === 'wots16-covenant';
        
        const vault = wots.restoreVaultFromSecret(secret);
        vault.secret = secret;
        
        console.log(`\n🔓 Sweeping vault: ${vault.vaultId}`);
        console.log(`   Security: ${secretData.securityLevel || 'standard'}`);
        
        const utxos = await getUTXOsByScriptHash(vault.wocScriptHash);
        console.log(`📥 Found ${utxos.length} UTXOs`);
        
        if (utxos.length === 0) {
            return res.status(400).json({ success: false, error: 'No funds in vault' });
        }
        
        let total = 0;
        utxos.forEach(u => total += u.value);
        console.log(`💰 Total: ${total} sats`);
        
        if (total < CONFIG.MIN_SWEEP) {
            return res.status(400).json({ success: false, error: `Insufficient funds: ${total} sats` });
        }
        
        const rate = parseInt(feeRate) || CONFIG.FEE_RATE_STANDARD;
        
        if (isCovenant && isWOTS16) {
            console.log('🛡️ Building WOTS-16 COVENANT transaction');
            const txResult = await buildWOTS16CovenantTransaction(vault, utxos, toAddress, rate);
            const result = await broadcastTransaction(txResult.rawTx);
            
            if (result.success) {
                res.json({
                    success: true,
                    txid: result.txid,
                    explorerLink: `https://whatsonchain.com/tx/${result.txid}`,
                    details: {
                        from: vault.vaultId,
                        to: toAddress,
                        inputValue: total,
                        outputValue: txResult.outputValue,
                        fee: txResult.fee,
                        size: txResult.txSize,
                        broadcastVia: result.via,
                        signatureType: 'WOTS-16 + Covenant',
                        frontRunImmune: true,
                        quantumSafeSpend: true
                    }
                });
            } else {
                res.status(400).json({ success: false, error: result.error });
            }
        } else {
            console.log('📝 Building standard transaction');
            const tx = buildStandardSweepTransaction(utxos, vault, toAddress, rate);
            const result = await broadcastTransaction(tx.rawHex);
            
            if (result.success) {
                res.json({
                    success: true,
                    txid: result.txid,
                    explorerLink: `https://whatsonchain.com/tx/${result.txid}`,
                    details: {
                        from: vault.vaultId,
                        to: toAddress,
                        inputValue: tx.inputValue,
                        outputValue: tx.outputValue,
                        fee: tx.fee,
                        size: tx.size,
                        broadcastVia: result.via,
                        signatureType: 'Winternitz OTS',
                        frontRunImmune: false,
                        quantumSafeSpend: false
                    }
                });
            } else {
                res.status(400).json({ success: false, error: result.error });
            }
        }
        
    } catch (error) {
        console.error('Sweep error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/price
 */
app.get('/api/price', async (req, res) => {
    try {
        const price = await getBSVPrice();
        res.json({ success: true, bsv_usd: price });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/tx/:txid
 */
app.get('/api/tx/:txid', async (req, res) => {
    try {
        const tx = await getTransaction(req.params.txid);
        res.json({ success: true, transaction: tx });
    } catch (error) {
        res.status(404).json({ success: false, error: error.message });
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║        BSV QUANTUM VAULT - Server v4.6 (COMPLETE)             ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  Local:  http://localhost:${PORT}                                 ║`);
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log('║  ✅ /api/check-funding - Shows deposit button when funded      ║');
    console.log('║  ✅ /api/deposit-to-vault - Accepts vaultSecret               ║');
    console.log('║  ✅ /api/verify - Returns derived for frontend                ║');
    console.log('║  ✅ All endpoints frontend-compatible                         ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');
});

module.exports = app;
