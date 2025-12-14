/**
 * BSV QUANTUM VAULT - Production Server v3.0
 * 
 * CRITICAL UPGRADES:
 * ==================
 * 1. NO MORE P2SH - Uses bare scripts (BSV Genesis compatible)
 * 2. Full transaction building for bare script outputs
 * 3. Proper fee estimation for larger Winternitz transactions
 * 4. Multiple broadcast endpoints for reliability
 * 
 * SECURITY MODEL:
 * ===============
 * This server provides quantum-resistant Bitcoin storage with:
 * - Hash-based signatures (no ECDSA for vault security)
 * - 1024 bytes of key entropy
 * - BSV mainnet compatible bare scripts
 * 
 * @author BSV Quantum Vault
 * @version 3.0.0
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');

// Winternitz module v3
const wots = require('./winternitz');

// BSV Library for proper transaction signing
let bsv = null;
try {
    bsv = require('bsv');
    console.log('✅ BSV library loaded - transactions will be signed correctly');
} catch (e) {
    console.log('⚠️ BSV library not found. Install with: npm install bsv');
    console.log('   Transactions will fail until bsv library is installed.');
}

const app = express();
const PORT = process.env.PORT || 4000;

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    // WhatsOnChain API (primary)
    WOC_BASE: 'https://api.whatsonchain.com/v1/bsv/main',
    
    // TAAL Merchant API (for large/non-standard transactions)
    TAAL_URL: 'https://api.taal.com/api/v1/broadcast',
    TAAL_KEYS: process.env.TAAL_API_KEYS?.split(',') || [
    // API_KEYS_GO_HERE, 
    ],
    
    // GorillaPool (alternative)
    GORILLA_URL: 'https://mapi.gorillapool.io/mapi/tx',
    
    // Fee rates (satoshis per byte)
    FEE_RATE_STANDARD: 1,
    FEE_RATE_PRIORITY: 2,
    
    // Minimum amounts
    MIN_OUTPUT: 546,        // Dust limit
    MIN_SWEEP: 2000,        // Minimum for fees
    
    // Timeouts
    API_TIMEOUT: 45000
};

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Request logging
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

// Base58 encoding/decoding
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
        throw new Error('Failed to fetch balance');
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
        throw new Error('Failed to fetch UTXOs');
    }
}

/**
 * Get UTXOs by script hash (for bare scripts)
 */
async function getUTXOsByScriptHash(scriptHash) {
    try {
        const response = await axios.get(
            `${CONFIG.WOC_BASE}/script/${scriptHash}/unspent`,
            { timeout: CONFIG.API_TIMEOUT }
        );
        return response.data || [];
    } catch (error) {
        // If script endpoint fails, it might not have any UTXOs
        console.error('Script UTXO fetch error:', error.message);
        return [];
    }
}

/**
 * Get current BSV/USD price
 */
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

/**
 * Broadcast transaction via multiple endpoints
 */
async function broadcastTransaction(rawHex) {
    const errors = [];
    
    // Try TAAL first (better for non-standard transactions)
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

/**
 * Get transaction details
 */
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

// =============================================================================
// TRANSACTION BUILDING
// =============================================================================

/**
 * Build a sweep transaction from quantum vault
 * 
 * CRITICAL: This handles bare script outputs properly
 */
function buildSweepTransaction(utxos, vault, toAddress, feeRate = CONFIG.FEE_RATE_STANDARD) {
    // Calculate total input
    let totalInput = 0;
    utxos.forEach(u => totalInput += u.value);
    
    // Get unlocking data
    const unlockData = wots.createUnlockingData(vault);
    
    // Calculate sizes
    // ScriptSig for bare script: push(1024 bytes)
    const scriptSigSize = 2 + unlockData.preimageSize; // OP_PUSHDATA2 + len + data
    const inputSize = 32 + 4 + 1 + scriptSigSize + 4;  // txid + vout + scriptSigLen + scriptSig + sequence
    const outputSize = 8 + 1 + 25;  // value + scriptLen + P2PKH script
    const txOverhead = 4 + 1 + 1 + 4; // version + inputCount + outputCount + locktime
    
    const estimatedSize = txOverhead + (utxos.length * inputSize) + outputSize;
    const fee = Math.ceil(estimatedSize * feeRate);
    
    const outputValue = totalInput - fee;
    
    if (outputValue < CONFIG.MIN_OUTPUT) {
        throw new Error(`Insufficient funds: ${totalInput} sats - ${fee} fee = ${outputValue} (minimum ${CONFIG.MIN_OUTPUT})`);
    }
    
    // Build destination script
    const outputScript = buildOutputScript(toAddress);
    
    // Build raw transaction
    const rawTx = buildRawTransaction(
        utxos,
        vault.lockingScript,
        unlockData.scriptSig,
        outputScript,
        outputValue
    );
    
    const txid = hash256(rawTx).reverse().toString('hex');
    
    return {
        rawHex: rawTx.toString('hex'),
        txid,
        fee,
        outputValue,
        inputValue: totalInput,
        size: rawTx.length,
        inputs: utxos.length
    };
}

/**
 * Build output script for address
 */
function buildOutputScript(address) {
    if (address.startsWith('1')) {
        // P2PKH
        const decoded = base58Decode(address);
        const pubKeyHash = decoded.slice(1, 21);
        return Buffer.concat([
            Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 PUSH20
            pubKeyHash,
            Buffer.from([0x88, 0xac])        // OP_EQUALVERIFY OP_CHECKSIG
        ]);
    }
    
    throw new Error('Invalid destination address. Must start with "1" (P2PKH)');
}

/**
 * Build raw transaction hex
 */
function buildRawTransaction(utxos, lockingScript, scriptSig, outputScript, outputValue) {
    const parts = [];
    
    // Version (4 bytes, little-endian)
    parts.push(Buffer.from([0x01, 0x00, 0x00, 0x00]));
    
    // Input count (varint)
    parts.push(encodeVarInt(utxos.length));
    
    // Inputs
    for (const utxo of utxos) {
        // Previous txid (32 bytes, reversed)
        parts.push(Buffer.from(utxo.tx_hash, 'hex').reverse());
        
        // Previous output index (4 bytes, little-endian)
        const voutBuf = Buffer.alloc(4);
        voutBuf.writeUInt32LE(utxo.tx_pos);
        parts.push(voutBuf);
        
        // ScriptSig (the unlocking data)
        parts.push(encodeVarInt(scriptSig.length));
        parts.push(scriptSig);
        
        // Sequence (4 bytes)
        parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    }
    
    // Output count (varint)
    parts.push(encodeVarInt(1));
    
    // Output value (8 bytes, little-endian)
    const valueBuf = Buffer.alloc(8);
    valueBuf.writeBigUInt64LE(BigInt(outputValue));
    parts.push(valueBuf);
    
    // Output script
    parts.push(encodeVarInt(outputScript.length));
    parts.push(outputScript);
    
    // Locktime (4 bytes)
    parts.push(Buffer.from([0x00, 0x00, 0x00, 0x00]));
    
    return Buffer.concat(parts);
}

/**
 * Encode variable-length integer
 */
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

// =============================================================================
// API ROUTES
// =============================================================================

/**
 * GET / - Serve the frontend
 */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * GET /api/create - Create a new quantum vault
 * 
 * Query parameters:
 * - security: 'standard' | 'enhanced' | 'maximum'
 * - lockTime: Unix timestamp or block height (0 for no lock)
 * - lockType: 'blocks' | 'timestamp'
 */
app.get('/api/create', (req, res) => {
    try {
        const securityLevel = req.query.security || 'standard';
        const lockTime = parseInt(req.query.lockTime) || 0;
        const lockType = req.query.lockType || 'blocks';
        
        const vault = wots.createQuantumVault({
            network: 'mainnet',
            securityLevel,
            lockTime,
            lockType
        });
        
        console.log(`✅ Created quantum vault: ${vault.vaultId}`);
        console.log(`   Script hash: ${vault.scriptHash}`);
        console.log(`   Security: ${vault.securityLevel}`);
        console.log(`   Script size: ${vault.scriptSize} bytes`);
        if (vault.lockTime > 0) {
            console.log(`   Time-lock: ${vault.unlockInfo?.description}`);
        }
        
        res.json({
            success: true,
            
            // Primary identifier
            vaultId: vault.vaultId,
            
            // For receiving funds
            scriptHash: vault.scriptHash,
            wocScriptHash: vault.wocScriptHash,
            lockingScript: vault.lockingScript,
            lockingScriptASM: vault.lockingScriptASM,
            scriptSize: vault.scriptSize,
            
            // CRITICAL - Save this!
            secret: vault.secret,
            
            // Configuration
            publicKeyHash: vault.publicKeyHash,
            scriptType: vault.scriptType,
            securityLevel: vault.securityLevel,
            
            // Time-lock info
            lockTime: vault.lockTime,
            unlockInfo: vault.unlockInfo,
            
            // Deposit info
            depositInfo: vault.depositInfo,
            
            // Sweep info
            sweepInfo: vault.sweepInfo,
            
            // Security metadata
            security: {
                signatureType: 'Winternitz One-Time Signature',
                keyEntropy: '1024 bytes (32 × 32-byte scalars)',
                hashFunction: 'SHA256',
                quantumResistant: true,
                frontRunProtected: securityLevel === 'maximum',
                timeLocked: vault.lockTime > 0,
                unlockInfo: vault.unlockInfo,
                p2shNote: 'BSV no longer supports P2SH. Use bare script outputs.',
                securityLevelDescription: getSecurityLevelDescription(securityLevel)
            }
        });
        
    } catch (error) {
        console.error('Create vault error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get description for security level
 */
function getSecurityLevelDescription(level) {
    switch (level) {
        case 'maximum':
            return 'Full Winternitz verification with transaction binding. ' +
                   'Signature is mathematically bound to specific transaction, ' +
                   'making front-running impossible. Larger script (~3KB), higher fees.';
        case 'enhanced':
            return 'Enhanced preimage verification with optional time-lock. ' +
                   'Good balance of security and efficiency. Medium script size.';
        case 'standard':
        default:
            return 'Simple preimage-based verification. Smallest script (~35 bytes), ' +
                   'lowest fees. Quantum-resistant but theoretically vulnerable to ' +
                   'front-running during spend (low practical risk).';
    }
}

/**
 * POST /api/fund-info - Get funding instructions for a vault
 */
app.post('/api/fund-info', (req, res) => {
    try {
        const { secret, scriptHash } = req.body;
        
        let vault;
        if (secret) {
            vault = wots.restoreVaultFromSecret(secret);
        } else if (scriptHash) {
            // Limited info without secret
            return res.json({
                success: true,
                scriptHash,
                note: 'To get full funding info, provide the vault secret'
            });
        } else {
            throw new Error('Secret or scriptHash required');
        }
        
        res.json({
            success: true,
            vaultId: vault.vaultId,
            scriptHash: vault.scriptHash,
            lockingScript: vault.lockingScriptHex,
            
            fundingInstructions: {
                method: 'bare-script',
                steps: [
                    '1. Create a transaction with an output',
                    '2. Set the output scriptPubKey to the lockingScript (not P2SH!)',
                    '3. Send any amount to this output',
                    '4. The funds are now locked in your quantum vault'
                ],
                lockingScriptHex: vault.lockingScriptHex,
                exampleOutput: {
                    value: 'any_satoshi_amount',
                    scriptPubKey: vault.lockingScriptHex
                },
                warning: 'Do NOT wrap this in P2SH (OP_HASH160 ... OP_EQUAL). BSV does not support P2SH since Genesis 2020.'
            }
        });
        
    } catch (error) {
        console.error('Fund info error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/balance - Check vault balance
 */
app.post('/api/balance', async (req, res) => {
    try {
        const { secret, scriptHash: providedHash } = req.body;
        
        let wocScriptHash;  // SHA256 format for WhatsOnChain
        let scriptHash;      // HASH160 format for display
        let vaultId;
        
        if (secret) {
            const vault = wots.restoreVaultFromSecret(secret);
            wocScriptHash = vault.wocScriptHash;
            scriptHash = vault.scriptHash;
            vaultId = vault.vaultId;
            console.log(`💰 Checking balance for vault: ${vaultId}`);
            console.log(`   WoC ScriptHash: ${wocScriptHash}`);
        } else if (providedHash) {
            // Assume provided hash is in WoC format (SHA256)
            wocScriptHash = providedHash;
            scriptHash = providedHash;
            vaultId = null;
        } else {
            throw new Error('Secret or scriptHash required');
        }
        
        // Try to get UTXOs by script hash (using WoC format)
        const utxos = await getUTXOsByScriptHash(wocScriptHash);
        
        let confirmed = 0;
        let unconfirmed = 0;
        
        for (const utxo of utxos) {
            if (utxo.height > 0) {
                confirmed += utxo.value;
            } else {
                unconfirmed += utxo.value;
            }
        }
        
        const total = confirmed + unconfirmed;
        const price = await getBSVPrice();
        const bsvAmount = total / 100000000;
        const usdValue = bsvAmount * price;
        
        res.json({
            success: true,
            vaultId,
            scriptHash,
            wocScriptHash,
            utxoCount: utxos.length,
            balance: {
                satoshis: total,
                bsv: bsvAmount.toFixed(8),
                usd: usdValue.toFixed(2),
                confirmed,
                unconfirmed
            },
            price: price.toFixed(2),
            canSweep: total >= CONFIG.MIN_SWEEP,
            sweepNote: total < CONFIG.MIN_SWEEP 
                ? `Minimum ${CONFIG.MIN_SWEEP} sats required for sweep transaction fees`
                : null
        });
        
    } catch (error) {
        console.error('Balance check error:', error);
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
            throw new Error('Vault secret required');
        }
        if (!toAddress) {
            throw new Error('Destination address required');
        }
        
        // Validate destination address
        if (!toAddress.startsWith('1')) {
            throw new Error('Destination must be a P2PKH address starting with "1"');
        }
        
        // Restore vault
        const vault = wots.restoreVaultFromSecret(secret);
        console.log(`🔓 Restoring vault: ${vault.vaultId}`);
        console.log(`   Script hash (HASH160): ${vault.scriptHash}`);
        console.log(`   Script hash (WoC/SHA256): ${vault.wocScriptHash}`);
        
        // Get UTXOs using WhatsOnChain-compatible scripthash (SHA256)
        const utxos = await getUTXOsByScriptHash(vault.wocScriptHash);
        console.log(`📥 Found ${utxos.length} UTXOs`);
        
        if (utxos.length === 0) {
            throw new Error('No funds found in vault');
        }
        
        // Calculate total
        let total = 0;
        utxos.forEach(u => total += u.value);
        console.log(`💰 Total: ${total} satoshis`);
        
        if (total < CONFIG.MIN_SWEEP) {
            throw new Error(`Insufficient funds: ${total} sats (minimum ${CONFIG.MIN_SWEEP} for fees)`);
        }
        
        // Build transaction
        const rate = parseInt(feeRate) || CONFIG.FEE_RATE_STANDARD;
        const tx = buildSweepTransaction(utxos, vault, toAddress, rate);
        console.log(`📝 Built transaction: ${tx.size} bytes, fee: ${tx.fee} sats`);
        
        // Broadcast
        const result = await broadcastTransaction(tx.rawHex);
        
        if (result.success) {
            console.log(`✅ Broadcast success via ${result.via}: ${result.txid}`);
            
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
                    feeRate: rate,
                    broadcastVia: result.via,
                    signatureType: 'Winternitz OTS (Quantum-Resistant)'
                }
            });
        } else {
            throw new Error(result.error);
        }
        
    } catch (error) {
        console.error('Sweep error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/verify - Verify a secret matches a vault
 */
app.post('/api/verify', (req, res) => {
    try {
        const { secret, scriptHash, vaultId } = req.body;
        
        if (!secret) {
            throw new Error('Secret required');
        }
        
        const vault = wots.restoreVaultFromSecret(secret);
        
        const matches = {
            scriptHash: scriptHash ? vault.scriptHash === scriptHash : null,
            vaultId: vaultId ? vault.vaultId === vaultId : null
        };
        
        res.json({
            success: true,
            matches,
            derived: {
                vaultId: vault.vaultId,
                scriptHash: vault.scriptHash,
                scriptType: vault.scriptType
            }
        });
        
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/info - Server and security information
 */
app.get('/api/info', (req, res) => {
    res.json({
        success: true,
        server: {
            name: 'BSV Quantum Vault',
            version: '3.0.0',
            network: 'mainnet'
        },
        security: {
            type: 'Winternitz One-Time Signature (WOTS)',
            quantumResistant: true,
            keySize: '1024 bytes (32 × 32-byte scalars)',
            hashFunction: 'HASH256 (double SHA256)',
            iterations: 256,
            outputType: 'Bare script (NOT P2SH - BSV Genesis compliant)'
        },
        important: {
            p2shWarning: 'BSV deprecated P2SH in the Genesis upgrade (Feb 2020). This vault uses bare scripts.',
            funding: 'To fund a vault, create a transaction output with the lockingScript directly as scriptPubKey.',
            security: 'Store your master secret offline. It is the ONLY way to recover your funds.'
        }
    });
});

/**
 * GET /api/price - Current BSV price
 */
app.get('/api/price', async (req, res) => {
    try {
        const price = await getBSVPrice();
        res.json({ success: true, price, currency: 'USD' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// FUNDING SYSTEM - Easy deposit via temporary P2PKH address
// =============================================================================

/**
 * POST /api/generate-funding-address - Generate a temporary funding address
 * 
 * This creates a P2PKH address that users can send to from any wallet.
 * The private key is returned so the app can sweep funds to the quantum vault.
 * 
 * NOW USES BSV LIBRARY for consistent key derivation
 * FIXED: Stores WIF to preserve compression flag
 */
app.post('/api/generate-funding-address', (req, res) => {
    try {
        if (!bsv) {
            throw new Error('BSV library not installed. Run: npm install bsv');
        }
        
        // Generate a new private key using BSV library
        const bsvPrivKey = new bsv.PrivateKey();
        const bsvPubKey = bsvPrivKey.toPublicKey();
        const bsvAddress = bsvPrivKey.toAddress();
        
        // Create WIF - THIS IS THE KEY! WIF preserves compression flag
        const wif = bsvPrivKey.toWIF();
        
        // Get other values for display
        const privateKeyHex = bsvPrivKey.bn.toBuffer({size: 32}).toString('hex');
        const publicKeyHex = bsvPubKey.toString();
        const publicKeyHash = bsv.crypto.Hash.sha256ripemd160(bsvPubKey.toBuffer());
        
        // Get address string
        const address = bsvAddress.toString();
        
        // CRITICAL: Store WIF in fundingData (not just hex) to preserve compression
        const fundingData = {
            address,
            privateKeyWIF: wif,  // STORE WIF - includes compression flag!
            privateKeyHex: privateKeyHex,
            publicKeyHash: publicKeyHash.toString('hex'),
            publicKeyHex: publicKeyHex,
            created: Date.now(),
            network: 'mainnet'
        };
        
        console.log(`💳 Generated funding address: ${address}`);
        console.log(`   PubKey: ${publicKeyHex.substring(0, 20)}...`);
        console.log(`   WIF starts with: ${wif.substring(0, 4)}...`);
        
        res.json({
            success: true,
            fundingAddress: address,
            fundingData: Buffer.from(JSON.stringify(fundingData)).toString('base64'),
            qrData: `bitcoin:${address}`,
            
            // Keys for user transparency
            keys: {
                privateKeyWIF: wif,
                privateKeyHex: privateKeyHex,
                publicKeyHex: publicKeyHex,
                publicKeyHash: publicKeyHash.toString('hex')
            },
            
            instructions: {
                step1: 'Scan the QR code or copy the address',
                step2: 'Send BSV from any wallet to this address',
                step3: 'Click "Deposit to Vault" once funds arrive',
                note: 'This is a temporary address - funds will be swept to your quantum vault',
                keyNote: 'Save the WIF private key if you want to import this address into another wallet'
            }
        });
        
    } catch (error) {
        console.error('Generate funding address error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Create WIF (Wallet Import Format) from private key - FALLBACK if BSV lib not used
 */
function createWIF(privateKey, network = 'mainnet', compressed = true) {
    const version = network === 'mainnet' ? 0x80 : 0xef;
    
    let payload;
    if (compressed) {
        payload = Buffer.concat([
            Buffer.from([version]),
            privateKey,
            Buffer.from([0x01]) // compression flag
        ]);
    } else {
        payload = Buffer.concat([
            Buffer.from([version]),
            privateKey
        ]);
    }
    
    const checksum = hash256(payload).slice(0, 4);
    return base58Encode(Buffer.concat([payload, checksum]));
}

/**
 * POST /api/send-from-funding - Send funds from funding address to ANY address
 * 
 * This allows the user to change their mind and send elsewhere instead of vault
 */
app.post('/api/send-from-funding', async (req, res) => {
    try {
        const { fundingData, toAddress, amount } = req.body;
        
        if (!fundingData) {
            throw new Error('Funding data required');
        }
        if (!toAddress) {
            throw new Error('Destination address required');
        }
        
        // Validate destination address (must be P2PKH for simplicity)
        if (!toAddress.startsWith('1')) {
            throw new Error('Destination must be a P2PKH address starting with "1"');
        }
        
        // Decode funding data
        const funding = JSON.parse(Buffer.from(fundingData, 'base64').toString());
        
        // FIXED: Use WIF to recover key (preserves compression flag!)
        let bsvPrivKey;
        
        if (funding.privateKeyWIF) {
            console.log('🔑 Recovering key from WIF...');
            bsvPrivKey = bsv.PrivateKey.fromWIF(funding.privateKeyWIF);
        } else if (funding.privateKeyHex) {
            console.log('⚠️ No WIF found, trying hex recovery...');
            const rawKeyBuffer = Buffer.from(funding.privateKeyHex, 'hex');
            bsvPrivKey = new bsv.PrivateKey(rawKeyBuffer, 'livenet');
        } else {
            throw new Error('No private key found in funding data');
        }
        
        // Verify the key matches the expected address
        const derivedAddress = bsvPrivKey.toAddress().toString();
        
        if (derivedAddress !== funding.address) {
            console.log(`❌ Address mismatch! Derived: ${derivedAddress}, Expected: ${funding.address}`);
            throw new Error(`Key mismatch: derived ${derivedAddress} but expected ${funding.address}`);
        }
        
        console.log(`💸 Sending from funding address: ${funding.address}`);
        console.log(`   To: ${toAddress}`);
        
        // Get UTXOs from funding address
        const utxos = await getUTXOs(funding.address);
        console.log(`📥 Found ${utxos.length} UTXOs`);
        
        if (utxos.length === 0) {
            throw new Error('No funds found in funding address');
        }
        
        // Calculate total available
        let totalInput = 0;
        utxos.forEach(u => totalInput += u.value);
        console.log(`💰 Total available: ${totalInput} satoshis`);
        
        // Calculate fee (P2PKH to P2PKH is ~225 bytes per input + 34 bytes output)
        const estimatedSize = 10 + (utxos.length * 148) + 34;
        const fee = Math.ceil(estimatedSize * CONFIG.FEE_RATE_STANDARD);
        
        // Determine send amount
        let sendAmount;
        if (amount && amount !== 'all') {
            sendAmount = parseInt(amount);
            if (sendAmount + fee > totalInput) {
                throw new Error(`Insufficient funds: need ${sendAmount + fee} sats, have ${totalInput}`);
            }
        } else {
            // Send all (sweep)
            sendAmount = totalInput - fee;
        }
        
        if (sendAmount < CONFIG.MIN_OUTPUT) {
            throw new Error(`Amount too small: ${sendAmount} sats (minimum ${CONFIG.MIN_OUTPUT})`);
        }
        
        console.log(`📝 Building transaction:`);
        console.log(`   Send: ${sendAmount} sats`);
        console.log(`   Fee: ${fee} sats`);
        
        // Build and sign transaction using BSV library
        const rawTx = buildP2PKHTransaction(
            utxos,
            bsvPrivKey,  // Pass the BSV PrivateKey object
            funding.publicKeyHash,
            toAddress,   // Pass destination address directly
            sendAmount
        );
        
        console.log(`📡 Broadcasting ${rawTx.length} byte transaction...`);
        
        // Broadcast
        const result = await broadcastTransaction(rawTx.toString('hex'));
        
        if (result.success) {
            const txid = result.txid;
            console.log(`✅ Send successful via ${result.via}: ${txid}`);
            
            res.json({
                success: true,
                txid,
                explorerLink: `https://whatsonchain.com/tx/${txid}`,
                details: {
                    fromAddress: funding.address,
                    toAddress: toAddress,
                    amount: sendAmount,
                    fee,
                    size: rawTx.length,
                    broadcastVia: result.via
                },
                message: 'Funds sent successfully!'
            });
        } else {
            throw new Error(result.error);
        }
        
    } catch (error) {
        console.error('Send from funding error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * Build a standard P2PKH to P2PKH transaction
 * Uses BSV library for correct signing
 */
function buildP2PKHTransaction(utxos, privateKey, pubKeyHashHex, destAddress, outputValue) {
    if (!bsv) {
        throw new Error('BSV library not installed. Run: npm install bsv');
    }
    
    // Handle both PrivateKey objects and raw buffers/hex
    let bsvPrivKey;
    if (privateKey instanceof bsv.PrivateKey) {
        bsvPrivKey = privateKey;
    } else {
        const privBuf = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey, 'hex');
        bsvPrivKey = new bsv.PrivateKey(privBuf, 'livenet');
    }
    
    const bsvAddress = bsvPrivKey.toAddress();
    
    // Handle destination - can be address string or script buffer
    let toAddress;
    if (typeof destAddress === 'string' && destAddress.startsWith('1')) {
        toAddress = destAddress;
    } else if (Buffer.isBuffer(destAddress) && destAddress.length === 25) {
        // Extract pubKeyHash from P2PKH script
        const destPubKeyHash = destAddress.slice(3, 23);
        toAddress = pubKeyHashToAddress(destPubKeyHash, 'mainnet');
    } else {
        throw new Error('Unsupported destination format');
    }
    
    console.log('🔑 BSV Library Signing:');
    console.log('   From:', bsvAddress.toString());
    console.log('   To:', toAddress);
    console.log('   Amount:', outputValue, 'sats');
    
    // Create transaction
    const tx = new bsv.Transaction();
    
    // Add inputs from UTXOs
    let totalInput = 0;
    for (const utxo of utxos) {
        tx.from({
            txId: utxo.tx_hash,
            outputIndex: utxo.tx_pos,
            script: bsv.Script.buildPublicKeyHashOut(bsvAddress),
            satoshis: utxo.value
        });
        totalInput += utxo.value;
        console.log(`   Input: ${utxo.tx_hash.substring(0, 16)}... ${utxo.value} sats`);
    }
    
    // Add output
    tx.to(toAddress, outputValue);
    
    // Sign all inputs
    tx.sign(bsvPrivKey);
    
    if (!tx.isFullySigned()) {
        throw new Error('Transaction signing failed - not fully signed');
    }
    
    console.log('✅ Transaction signed successfully');
    console.log(`📦 Size: ${tx.serialize().length / 2} bytes`);
    console.log(`💰 Fee: ${totalInput - outputValue} sats`);
    
    return Buffer.from(tx.serialize(), 'hex');
}

/**
 * Convert pubKeyHash to BSV address
 */
function pubKeyHashToAddress(pubKeyHash, network = 'mainnet') {
    const version = network === 'mainnet' ? 0x00 : 0x6f;
    const payload = Buffer.concat([Buffer.from([version]), pubKeyHash]);
    const checksum = hash256(payload).slice(0, 4);
    return base58Encode(Buffer.concat([payload, checksum]));
}

/**
 * Create sighash for P2PKH transaction (alias for consistency)
 */
function createP2PKHSighash(utxos, inputIndex, scriptCode, inputValue, outputScript, outputValue) {
    return createBIP143Sighash(utxos, inputIndex, scriptCode, inputValue, outputScript, outputValue);
}

/**
 * POST /api/check-funding - Check balance of funding address
 */
app.post('/api/check-funding', async (req, res) => {
    try {
        const { fundingData } = req.body;
        
        if (!fundingData) {
            throw new Error('Funding data required');
        }
        
        const decoded = JSON.parse(Buffer.from(fundingData, 'base64').toString());
        const address = decoded.address;
        
        // Get balance and UTXOs
        const balance = await getBalance(address);
        const utxos = await getUTXOs(address);
        const price = await getBSVPrice();
        
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
 * POST /api/deposit-to-vault - Sweep from funding address to quantum vault
 * 
 * This is the magic - takes funds from the simple P2PKH address and
 * creates a proper bare script output for the quantum vault.
 */
app.post('/api/deposit-to-vault', async (req, res) => {
    try {
        const { fundingData, vaultSecret, amount } = req.body;
        
        if (!fundingData) throw new Error('Funding data required');
        if (!vaultSecret) throw new Error('Vault secret required');
        
        const funding = JSON.parse(Buffer.from(fundingData, 'base64').toString());
        
        // FIXED: Use WIF to recover key (preserves compression flag!)
        let bsvPrivKey;
        
        if (funding.privateKeyWIF) {
            // Best method: Use WIF which includes compression flag
            console.log('🔑 Recovering key from WIF...');
            bsvPrivKey = bsv.PrivateKey.fromWIF(funding.privateKeyWIF);
        } else if (funding.privateKeyHex) {
            // Fallback: Try hex (may have compression issues)
            console.log('⚠️ No WIF found, trying hex recovery...');
            const rawKeyBuffer = Buffer.from(funding.privateKeyHex, 'hex');
            bsvPrivKey = new bsv.PrivateKey(rawKeyBuffer, 'livenet');
        } else {
            throw new Error('No private key found in funding data');
        }
        
        // Verify the key matches the expected address
        const derivedAddress = bsvPrivKey.toAddress().toString();
        
        if (derivedAddress !== funding.address) {
            console.log(`❌ Address mismatch! Derived: ${derivedAddress}, Expected: ${funding.address}`);
            throw new Error(`Key mismatch: derived ${derivedAddress} but expected ${funding.address}`);
        }
        
        console.log(`✅ Key verified: ${derivedAddress}`);
        
        // Restore vault
        const vault = wots.restoreVaultFromSecret(vaultSecret);
        console.log(`🔐 Depositing to vault: ${vault.vaultId}`);
        
        // Get UTXOs
        const utxos = await getUTXOs(funding.address);
        console.log(`📥 Found ${utxos.length} UTXOs in funding address`);
        
        if (utxos.length === 0) throw new Error('No funds found in funding address');
        
        let totalInput = 0;
        utxos.forEach(u => totalInput += u.value);
        console.log(`💰 Total available: ${totalInput} satoshis`);
        
        // Calculate fee
        const lockingScriptSize = vault.lockingScript.length / 2;
        const estimatedSize = 10 + (utxos.length * 148) + lockingScriptSize + 9;
        const fee = Math.ceil(estimatedSize * CONFIG.FEE_RATE_STANDARD);
        
        if (totalInput < fee + CONFIG.MIN_OUTPUT) {
            throw new Error(`Insufficient funds: ${totalInput} sats (need ${fee + CONFIG.MIN_OUTPUT})`);
        }
        
        const outputValue = totalInput - fee;
        
        console.log(`📝 Building deposit transaction:`);
        console.log(`   Input: ${totalInput} sats`);
        console.log(`   Output: ${outputValue} sats (to vault)`);
        console.log(`   Fee: ${fee} sats`);
        
        // Build Transaction using the verified key
        const rawTx = buildDepositTransaction(
            utxos,
            bsvPrivKey,
            funding.publicKeyHash,
            vault.lockingScript,
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
                    vaultId: vault.vaultId,
                    amount: outputValue,
                    outputValue: outputValue,  // For frontend compatibility
                    fee,
                    fromAddress: funding.address,
                    broadcastVia: result.via
                }
            });
        } else {
            throw new Error(result.error);
        }
        
    } catch (error) {
        console.error('Deposit to vault error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * Derive public key hash from private key
 * For simplicity, we use a hash-based approach
 * In production, use secp256k1 ECDSA
 */
function derivePublicKeyHash(privateKey) {
    // Generate compressed public key using secp256k1
    // This is a simplified version - for production use a proper library
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(privateKey);
    const publicKey = ecdh.getPublicKey('', 'compressed');
    return hash160(publicKey);
}

/**
 * Create a P2PKH address from public key hash
 */
function createP2PKHAddress(pubKeyHash, network = 'mainnet') {
    const version = network === 'mainnet' ? 0x00 : 0x6f;
    const payload = Buffer.concat([
        Buffer.from([version]),
        pubKeyHash
    ]);
    const checksum = hash256(payload).slice(0, 4);
    return base58Encode(Buffer.concat([payload, checksum]));
}

/**
 * Build deposit transaction from P2PKH to quantum vault (bare script)
 * Uses BSV library for correct signing
 */
function buildDepositTransaction(utxos, privateKey, pubKeyHashHex, lockingScript, outputValue) {
    if (!bsv) throw new Error('BSV library not installed');
    
    // FIX: Handle both Raw Buffer AND pre-configured PrivateKey objects
    let bsvPrivKey;
    if (privateKey instanceof bsv.PrivateKey) {
        // Use the object directly (preserves compression settings)
        bsvPrivKey = privateKey;
    } else {
        // Fallback for raw buffers (force livenet)
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
 * Create BIP143 sighash for BSV (SIGHASH_ALL | SIGHASH_FORKID)
 */
function createBIP143Sighash(utxos, inputIndex, scriptCode, inputValue, outputScript, outputValue) {
    const parts = [];
    
    // 1. nVersion (4 bytes LE)
    parts.push(Buffer.from([0x01, 0x00, 0x00, 0x00]));
    
    // 2. hashPrevouts - double SHA256 of all outpoints
    const prevouts = Buffer.concat(utxos.map(u => {
        const txid = Buffer.from(u.tx_hash, 'hex').reverse();
        const vout = Buffer.alloc(4);
        vout.writeUInt32LE(u.tx_pos);
        return Buffer.concat([txid, vout]);
    }));
    parts.push(hash256(prevouts));
    
    // 3. hashSequence - double SHA256 of all sequences
    const sequences = Buffer.alloc(utxos.length * 4, 0xff);
    parts.push(hash256(sequences));
    
    // 4. outpoint being spent (36 bytes)
    const outpointTxid = Buffer.from(utxos[inputIndex].tx_hash, 'hex').reverse();
    const outpointVout = Buffer.alloc(4);
    outpointVout.writeUInt32LE(utxos[inputIndex].tx_pos);
    parts.push(outpointTxid);
    parts.push(outpointVout);
    
    // 5. scriptCode (with length prefix)
    parts.push(encodeVarInt(scriptCode.length));
    parts.push(scriptCode);
    
    // 6. value of the output being spent (8 bytes LE)
    const valBuf = Buffer.alloc(8);
    valBuf.writeBigUInt64LE(BigInt(inputValue));
    parts.push(valBuf);
    
    // 7. nSequence of the input (4 bytes)
    parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    
    // 8. hashOutputs - double SHA256 of all outputs
    const outValBuf = Buffer.alloc(8);
    outValBuf.writeBigUInt64LE(BigInt(outputValue));
    const outScriptBuf = Buffer.isBuffer(outputScript) ? outputScript : Buffer.from(outputScript, 'hex');
    const outputs = Buffer.concat([
        outValBuf,
        encodeVarInt(outScriptBuf.length),
        outScriptBuf
    ]);
    parts.push(hash256(outputs));
    
    // 9. nLocktime (4 bytes)
    parts.push(Buffer.from([0x00, 0x00, 0x00, 0x00]));
    
    // 10. sighash type (4 bytes LE) - SIGHASH_ALL | SIGHASH_FORKID = 0x41
    parts.push(Buffer.from([0x41, 0x00, 0x00, 0x00]));
    
    // Double SHA256 of the preimage
    const preimage = Buffer.concat(parts);
    return hash256(preimage);
}

/**
 * Build P2PKH script from public key hash
 */
function buildP2PKHScript(pubKeyHash) {
    return Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 PUSH20
        pubKeyHash,
        Buffer.from([0x88, 0xac])        // OP_EQUALVERIFY OP_CHECKSIG
    ]);
}

/**
 * Create sighash preimage for signing
 */
function createSighashPreimage(utxos, inputIndex, scriptCode, outputValue, outputScript) {
    const parts = [];
    
    // Version
    parts.push(Buffer.from([0x01, 0x00, 0x00, 0x00]));
    
    // hashPrevouts
    const prevouts = Buffer.concat(utxos.map(u => 
        Buffer.concat([
            Buffer.from(u.tx_hash, 'hex').reverse(),
            (() => { const b = Buffer.alloc(4); b.writeUInt32LE(u.tx_pos); return b; })()
        ])
    ));
    parts.push(hash256(prevouts));
    
    // hashSequence
    const sequences = Buffer.concat(utxos.map(() => Buffer.from([0xff, 0xff, 0xff, 0xff])));
    parts.push(hash256(sequences));
    
    // outpoint
    parts.push(Buffer.from(utxos[inputIndex].tx_hash, 'hex').reverse());
    const voutBuf = Buffer.alloc(4);
    voutBuf.writeUInt32LE(utxos[inputIndex].tx_pos);
    parts.push(voutBuf);
    
    // scriptCode
    parts.push(encodeVarInt(scriptCode.length));
    parts.push(scriptCode);
    
    // value
    const valBuf = Buffer.alloc(8);
    valBuf.writeBigUInt64LE(BigInt(utxos[inputIndex].value));
    parts.push(valBuf);
    
    // sequence
    parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    
    // hashOutputs
    const outputBuf = Buffer.alloc(8);
    outputBuf.writeBigUInt64LE(BigInt(outputValue));
    const outScript = Buffer.isBuffer(outputScript) ? outputScript : Buffer.from(outputScript, 'hex');
    const outputs = Buffer.concat([
        outputBuf,
        encodeVarInt(outScript.length),
        outScript
    ]);
    parts.push(hash256(outputs));
    
    // locktime
    parts.push(Buffer.from([0x00, 0x00, 0x00, 0x00]));
    
    // sighash type (SIGHASH_ALL | SIGHASH_FORKID)
    parts.push(Buffer.from([0x41, 0x00, 0x00, 0x00]));
    
    return hash256(Buffer.concat(parts));
}

/**
 * Sign with private key using ECDSA (with low-S normalization for BSV)
 */
function signWithPrivateKey(privateKey, messageHash) {
    // Create private key object
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(privateKey);
    const publicKey = ecdh.getPublicKey('', 'compressed');
    
    const privateKeyObject = crypto.createPrivateKey({
        key: {
            kty: 'EC',
            crv: 'secp256k1',
            d: privateKey.toString('base64url'),
            x: ecdh.getPublicKey().slice(1, 33).toString('base64url'),
            y: ecdh.getPublicKey().slice(33).toString('base64url')
        },
        format: 'jwk'
    });
    
    // Sign the hash directly (don't hash again - messageHash is already the sighash)
    let derSig = crypto.sign(null, messageHash, { key: privateKeyObject, dsaEncoding: 'der' });
    
    // Normalize to low-S (BIP-62 / BSV requirement)
    derSig = ensureLowS(derSig);
    
    // Verify the signature before returning (sanity check)
    const publicKeyObject = crypto.createPublicKey({
        key: {
            kty: 'EC',
            crv: 'secp256k1',
            x: ecdh.getPublicKey().slice(1, 33).toString('base64url'),
            y: ecdh.getPublicKey().slice(33).toString('base64url')
        },
        format: 'jwk'
    });
    
    const verified = crypto.verify(null, messageHash, { key: publicKeyObject, dsaEncoding: 'der' }, derSig);
    console.log(`🔐 Signature self-verify: ${verified ? '✓ PASS' : '✗ FAIL'}`);
    
    if (!verified) {
        throw new Error('Signature verification failed - this should not happen!');
    }
    
    // Append sighash type
    return Buffer.concat([derSig, Buffer.from([0x41])]); // SIGHASH_ALL | SIGHASH_FORKID
}

/**
 * Ensure signature has low-S value (required by BSV)
 * 
 * secp256k1 curve order N
 * If S > N/2, replace S with N - S
 */
function ensureLowS(derSignature) {
    // secp256k1 curve order N and N/2
    const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    const halfN = BigInt('0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0');
    
    // Parse DER signature
    // Format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
    if (derSignature[0] !== 0x30) {
        throw new Error('Invalid DER signature');
    }
    
    let offset = 2; // Skip 0x30 and length byte
    
    // Parse R
    if (derSignature[offset] !== 0x02) {
        throw new Error('Invalid DER signature: expected 0x02 for R');
    }
    offset++;
    const rLength = derSignature[offset];
    offset++;
    const r = derSignature.slice(offset, offset + rLength);
    offset += rLength;
    
    // Parse S
    if (derSignature[offset] !== 0x02) {
        throw new Error('Invalid DER signature: expected 0x02 for S');
    }
    offset++;
    const sLength = derSignature[offset];
    offset++;
    const s = derSignature.slice(offset, offset + sLength);
    
    // Convert S to BigInt (handle leading zeros properly)
    const sBigInt = BigInt('0x' + s.toString('hex'));
    
    // Check if S is high (greater than N/2)
    if (sBigInt > halfN) {
        // S is high, compute N - S
        const newSBigInt = N - sBigInt;
        
        // Convert back to buffer
        let newSHex = newSBigInt.toString(16);
        // Ensure even length
        if (newSHex.length % 2 !== 0) {
            newSHex = '0' + newSHex;
        }
        const newS = Buffer.from(newSHex, 'hex');
        
        // Re-encode DER with new S
        return encodeDER(r, newS);
    }
    
    return derSignature;
}

/**
 * Encode R and S as DER signature
 */
function encodeDER(r, s) {
    // Remove leading zeros but ensure positive (add 0x00 if high bit set)
    let rTrimmed = trimLeadingZeros(r);
    let sTrimmed = trimLeadingZeros(s);
    
    // Add leading 0x00 if high bit is set (to keep positive)
    if (rTrimmed.length > 0 && (rTrimmed[0] & 0x80)) {
        rTrimmed = Buffer.concat([Buffer.from([0x00]), rTrimmed]);
    }
    if (sTrimmed.length > 0 && (sTrimmed[0] & 0x80)) {
        sTrimmed = Buffer.concat([Buffer.from([0x00]), sTrimmed]);
    }
    
    // Handle empty case
    if (rTrimmed.length === 0) rTrimmed = Buffer.from([0x00]);
    if (sTrimmed.length === 0) sTrimmed = Buffer.from([0x00]);
    
    const totalLength = 2 + rTrimmed.length + 2 + sTrimmed.length;
    
    return Buffer.concat([
        Buffer.from([0x30, totalLength]),
        Buffer.from([0x02, rTrimmed.length]),
        rTrimmed,
        Buffer.from([0x02, sTrimmed.length]),
        sTrimmed
    ]);
}

/**
 * Remove leading zero bytes (but keep at least one byte)
 */
function trimLeadingZeros(buf) {
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0) {
        i++;
    }
    return buf.slice(i);
}

/**
 * GET /api/tx/:txid - Get transaction details
 */
app.get('/api/tx/:txid', async (req, res) => {
    try {
        const tx = await getTransaction(req.params.txid);
        res.json({ success: true, transaction: tx });
    } catch (error) {
        res.status(404).json({ success: false, error: error.message });
    }
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║        BSV QUANTUM VAULT - Production Server v3.0             ║');
    console.log('║        Quantum-Resistant • BSV Native • No P2SH               ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  Local:     http://localhost:${PORT}                              ║`);
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log('║  Security:  Winternitz One-Time Signatures                    ║');
    console.log('║  Key Size:  1024 bytes (32 × 32-byte scalars)                 ║');
    console.log('║  Hash:      HASH256 (256 iterations per chunk)                ║');
    console.log('║  Output:    Bare script (BSV Genesis compliant)               ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log('║  ⚠️  P2SH addresses are NOT supported on BSV since 2020        ║');
    console.log('║  ✅ This vault uses bare script outputs                        ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');
});

module.exports = app;
