/**
 * BSV QUANTUM VAULT - Server
 * 
 * A quantum-resistant vault using SHA256 hash-lock (P2SH)
 * Instead of ECDSA signatures, funds are secured by a secret preimage.
 * 
 * Features:
 * - Create hash-locked P2SH addresses
 * - Check vault balance via WhatsOnChain
 * - Sweep funds by revealing the secret
 * - Broadcast via TAAL or WhatsOnChain
 */

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');

// BSV Library
const bsv = require('bsv');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';
const TAAL_URL = 'https://api.taal.com/api/v1/broadcast';
const TAAL_KEYS = [
    'mainnet_3b1bf0f0d550275f1ba8676c1e224fc1',
    'mainnet_7bf481e9cd46f48c44a71de1b326bea4'
];

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Base58 Encoding (for legacy addresses)
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

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
    for (let k = 0; buffer[k] === 0 && k < buffer.length - 1; k++) {
        str += ALPHABET[0];
    }
    for (let q = digits.length - 1; q >= 0; q--) {
        str += ALPHABET[digits[q]];
    }
    return str;
}

function base58Decode(str) {
    const bytes = [0];
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        let value = ALPHABET.indexOf(c);
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
    // Add leading zeros
    for (let i = 0; i < str.length && str[i] === '1'; i++) {
        bytes.push(0);
    }
    return Buffer.from(bytes.reverse());
}

/**
 * Convert to Legacy P2SH Address (starts with '3')
 */
function toP2SHAddress(scriptHash160) {
    const version = Buffer.from([0x05]); // P2SH mainnet
    const payload = Buffer.concat([version, scriptHash160]);
    
    const checksum = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(payload).digest())
        .digest()
        .slice(0, 4);
    
    return base58Encode(Buffer.concat([payload, checksum]));
}

/**
 * Convert to Legacy P2PKH Address (starts with '1') - for reference
 */
function toP2PKHAddress(pubkeyHash160) {
    const version = Buffer.from([0x00]); // P2PKH mainnet
    const payload = Buffer.concat([version, pubkeyHash160]);
    
    const checksum = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(payload).digest())
        .digest()
        .slice(0, 4);
    
    return base58Encode(Buffer.concat([payload, checksum]));
}

/**
 * Hash160 (RIPEMD160(SHA256(data)))
 */
function hash160(buffer) {
    const sha256 = crypto.createHash('sha256').update(buffer).digest();
    return crypto.createHash('ripemd160').update(sha256).digest();
}

/**
 * Double SHA256
 */
function doubleSha256(buffer) {
    return crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(buffer).digest())
        .digest();
}

// =============================================================================
// QUANTUM VAULT CORE
// =============================================================================

/**
 * Create a Quantum Vault
 * 
 * The locking script is: OP_SHA256 <32-byte-hash> OP_EQUAL
 * Hex: a8 20 <hash> 87
 * 
 * To spend, provide the preimage (secret) that hashes to the commitment.
 */
function createQuantumVault() {
    // Generate 32-byte random secret
    const secret = crypto.randomBytes(32);
    
    // SHA256 hash of the secret (this is the commitment)
    const secretHash = crypto.createHash('sha256').update(secret).digest();
    
    // Build the locking script (redeemScript)
    // OP_SHA256 (0xa8) + PUSH32 (0x20) + <32-byte hash> + OP_EQUAL (0x87)
    const redeemScript = Buffer.concat([
        Buffer.from([0xa8]),           // OP_SHA256
        Buffer.from([0x20]),           // Push 32 bytes
        secretHash,                     // The hash commitment
        Buffer.from([0x87])            // OP_EQUAL
    ]);
    
    // P2SH address = Hash160(redeemScript)
    const scriptHash = hash160(redeemScript);
    
    // Generate the P2SH address
    const p2shAddress = toP2SHAddress(scriptHash);
    
    // Also generate a reference P2PKH-style address (for compatibility display)
    const p2pkhStyleAddress = toP2PKHAddress(scriptHash);
    
    return {
        secret: secret.toString('hex'),
        secretHash: secretHash.toString('hex'),
        redeemScript: redeemScript.toString('hex'),
        scriptHash: scriptHash.toString('hex'),
        address: p2shAddress,                    // Main P2SH address (starts with 3)
        addressAlt: p2pkhStyleAddress,           // Alternative format
        lockingScriptASM: `OP_SHA256 ${secretHash.toString('hex')} OP_EQUAL`
    };
}

/**
 * Derive vault address from secret
 */
function deriveVaultFromSecret(secretHex) {
    const secret = Buffer.from(secretHex, 'hex');
    const secretHash = crypto.createHash('sha256').update(secret).digest();
    
    const redeemScript = Buffer.concat([
        Buffer.from([0xa8, 0x20]),
        secretHash,
        Buffer.from([0x87])
    ]);
    
    const scriptHash = hash160(redeemScript);
    const address = toP2SHAddress(scriptHash);
    
    return {
        address,
        secretHash: secretHash.toString('hex'),
        redeemScript: redeemScript.toString('hex'),
        scriptHash: scriptHash.toString('hex')
    };
}

// =============================================================================
// NETWORK FUNCTIONS (WhatsOnChain & TAAL)
// =============================================================================

/**
 * Get address balance from WhatsOnChain
 */
async function getBalance(address) {
    try {
        const response = await axios.get(`${WOC_BASE}/address/${address}/balance`, {
            timeout: 10000
        });
        return {
            confirmed: response.data.confirmed || 0,
            unconfirmed: response.data.unconfirmed || 0,
            total: (response.data.confirmed || 0) + (response.data.unconfirmed || 0)
        };
    } catch (error) {
        console.error('Balance fetch error:', error.message);
        throw new Error('Failed to fetch balance: ' + error.message);
    }
}

/**
 * Get UTXOs for an address
 */
async function getUTXOs(address) {
    try {
        const response = await axios.get(`${WOC_BASE}/address/${address}/unspent`, {
            timeout: 10000
        });
        return response.data || [];
    } catch (error) {
        console.error('UTXO fetch error:', error.message);
        throw new Error('Failed to fetch UTXOs: ' + error.message);
    }
}

/**
 * Get current BSV price
 */
async function getBSVPrice() {
    try {
        const response = await axios.get(`${WOC_BASE}/exchangerate`, { timeout: 5000 });
        return response.data.rate || 0;
    } catch (error) {
        return 0;
    }
}

/**
 * Broadcast transaction via TAAL (primary) or WhatsOnChain (fallback)
 */
async function broadcastTransaction(rawHex) {
    // Try TAAL first
    for (const key of TAAL_KEYS) {
        try {
            console.log('Broadcasting via TAAL...');
            const response = await axios.post(TAAL_URL, 
                { rawTx: rawHex },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${key}`
                    },
                    timeout: 15000
                }
            );
            
            if (response.status === 200) {
                const txid = response.data.txid || response.data.result || response.data;
                console.log('TAAL broadcast success:', txid);
                return { success: true, txid: txid.toString().replace(/"/g, '') };
            }
        } catch (error) {
            console.log('TAAL attempt failed:', error.message);
            continue;
        }
    }
    
    // Fallback to WhatsOnChain
    try {
        console.log('Broadcasting via WhatsOnChain...');
        const response = await axios.post(`${WOC_BASE}/tx/raw`,
            { txhex: rawHex },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            }
        );
        
        const txid = response.data.toString().replace(/"/g, '').trim();
        console.log('WoC broadcast success:', txid);
        return { success: true, txid };
    } catch (error) {
        console.error('Broadcast failed:', error.response?.data || error.message);
        return { 
            success: false, 
            error: error.response?.data?.message || error.message 
        };
    }
}

// =============================================================================
// TRANSACTION BUILDING
// =============================================================================

/**
 * Build a sweep transaction from the quantum vault
 * 
 * The unlocking script (scriptSig) for P2SH is:
 * <data that satisfies redeemScript> <redeemScript>
 * 
 * For our hash-lock: <secret> <redeemScript>
 */
function buildSweepTransaction(utxos, secret, redeemScript, toAddress, feeRate = 1) {
    const secretBuf = Buffer.from(secret, 'hex');
    const redeemScriptBuf = Buffer.from(redeemScript, 'hex');
    
    // Calculate total input value
    let totalInput = 0;
    utxos.forEach(utxo => {
        totalInput += utxo.value;
    });
    
    // Estimate transaction size
    // ~148 bytes per input (for P2SH with ~35 byte scriptSig) + ~34 bytes per output + 10 bytes overhead
    const estimatedSize = (utxos.length * 180) + 34 + 10;
    const fee = Math.ceil(estimatedSize * feeRate);
    
    const outputValue = totalInput - fee;
    
    if (outputValue <= 0) {
        throw new Error(`Insufficient funds. Total: ${totalInput} sats, Fee: ${fee} sats`);
    }
    
    // Decode destination address to get pubKeyHash
    let outputScript;
    if (toAddress.startsWith('1')) {
        // P2PKH address
        const decoded = base58Decode(toAddress);
        const pubKeyHash = decoded.slice(1, 21); // Skip version byte, take 20 bytes
        
        // P2PKH scriptPubKey: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
        outputScript = Buffer.concat([
            Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 PUSH20
            pubKeyHash,
            Buffer.from([0x88, 0xac])        // OP_EQUALVERIFY OP_CHECKSIG
        ]);
    } else if (toAddress.startsWith('3')) {
        // P2SH address
        const decoded = base58Decode(toAddress);
        const scriptHash = decoded.slice(1, 21);
        
        // P2SH scriptPubKey: OP_HASH160 <20 bytes> OP_EQUAL
        outputScript = Buffer.concat([
            Buffer.from([0xa9, 0x14]),       // OP_HASH160 PUSH20
            scriptHash,
            Buffer.from([0x87])              // OP_EQUAL
        ]);
    } else {
        throw new Error('Invalid destination address format. Use legacy BSV address (starting with 1 or 3)');
    }
    
    // Build raw transaction
    const tx = buildRawTransaction(utxos, outputScript, outputValue, secretBuf, redeemScriptBuf);
    
    return {
        rawHex: tx.toString('hex'),
        txid: doubleSha256(tx).reverse().toString('hex'),
        fee,
        outputValue,
        inputValue: totalInput
    };
}

/**
 * Build raw transaction bytes
 */
function buildRawTransaction(utxos, outputScript, outputValue, secret, redeemScript) {
    const parts = [];
    
    // Version (4 bytes, little-endian)
    parts.push(Buffer.from([0x01, 0x00, 0x00, 0x00]));
    
    // Input count (varint)
    parts.push(encodeVarInt(utxos.length));
    
    // Inputs
    for (const utxo of utxos) {
        // Previous txid (32 bytes, reversed)
        const txidBuf = Buffer.from(utxo.tx_hash, 'hex').reverse();
        parts.push(txidBuf);
        
        // Previous output index (4 bytes, little-endian)
        const voutBuf = Buffer.alloc(4);
        voutBuf.writeUInt32LE(utxo.tx_pos);
        parts.push(voutBuf);
        
        // ScriptSig: <secret> <redeemScript>
        // Format: <len><secret><len><redeemScript>
        const scriptSig = Buffer.concat([
            encodeVarInt(secret.length),
            secret,
            encodeVarInt(redeemScript.length),
            redeemScript
        ]);
        
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
 * GET /api/create - Create a new quantum vault
 */
app.get('/api/create', (req, res) => {
    try {
        const vault = createQuantumVault();
        console.log(`Created vault: ${vault.address}`);
        res.json({
            success: true,
            ...vault
        });
    } catch (error) {
        console.error('Create vault error:', error);
        res.json({ success: false, error: error.message });
    }
});

/**
 * POST /api/balance - Check vault balance
 * Body: { address } or { secret }
 */
app.post('/api/balance', async (req, res) => {
    try {
        let { address, secret } = req.body;
        
        // If secret provided, derive address
        if (!address && secret) {
            if (secret.length !== 64) {
                throw new Error('Invalid secret format (must be 64 hex characters)');
            }
            const derived = deriveVaultFromSecret(secret);
            address = derived.address;
        }
        
        if (!address) {
            throw new Error('Address or secret required');
        }
        
        const balance = await getBalance(address);
        const price = await getBSVPrice();
        const bsvAmount = balance.total / 100000000;
        const usdValue = bsvAmount * price;
        
        res.json({
            success: true,
            address,
            balance: balance.total,
            confirmed: balance.confirmed,
            unconfirmed: balance.unconfirmed,
            bsv: bsvAmount.toFixed(8),
            usd: usdValue.toFixed(2),
            price: price.toFixed(2)
        });
    } catch (error) {
        console.error('Balance check error:', error);
        res.json({ success: false, error: error.message });
    }
});

/**
 * POST /api/sweep - Sweep all funds from vault
 * Body: { secret, toAddress }
 */
app.post('/api/sweep', async (req, res) => {
    try {
        const { secret, toAddress } = req.body;
        
        if (!secret || !toAddress) {
            throw new Error('Secret and destination address required');
        }
        
        if (secret.length !== 64) {
            throw new Error('Invalid secret format (must be 64 hex characters)');
        }
        
        // Derive vault info from secret
        const vault = deriveVaultFromSecret(secret);
        console.log(`Sweeping from vault: ${vault.address}`);
        
        // Get UTXOs
        const utxos = await getUTXOs(vault.address);
        console.log(`Found ${utxos.length} UTXOs`);
        
        if (utxos.length === 0) {
            throw new Error('No funds found in vault');
        }
        
        // Calculate total
        let total = 0;
        utxos.forEach(u => total += u.value);
        console.log(`Total: ${total} satoshis`);
        
        if (total < 1000) {
            throw new Error(`Insufficient funds: ${total} sats (minimum 1000 sats needed for fees)`);
        }
        
        // Build transaction
        const tx = buildSweepTransaction(
            utxos,
            secret,
            vault.redeemScript,
            toAddress,
            1  // 1 sat/byte fee rate
        );
        
        console.log(`Built transaction: ${tx.rawHex.length / 2} bytes, fee: ${tx.fee} sats`);
        
        // Broadcast
        const result = await broadcastTransaction(tx.rawHex);
        
        if (result.success) {
            res.json({
                success: true,
                txid: result.txid,
                message: 'Transaction broadcast successfully!',
                explorerLink: `https://whatsonchain.com/tx/${result.txid}`,
                details: {
                    from: vault.address,
                    to: toAddress,
                    amount: tx.outputValue,
                    fee: tx.fee
                }
            });
        } else {
            throw new Error(result.error || 'Broadcast failed');
        }
        
    } catch (error) {
        console.error('Sweep error:', error);
        res.json({ success: false, error: error.message });
    }
});

/**
 * GET /api/price - Get current BSV price
 */
app.get('/api/price', async (req, res) => {
    try {
        const price = await getBSVPrice();
        res.json({ success: true, price });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

/**
 * POST /api/verify - Verify a secret matches an address
 * Body: { secret, address }
 */
app.post('/api/verify', (req, res) => {
    try {
        const { secret, address } = req.body;
        
        if (!secret || !address) {
            throw new Error('Secret and address required');
        }
        
        const derived = deriveVaultFromSecret(secret);
        const matches = derived.address === address;
        
        res.json({
            success: true,
            matches,
            derivedAddress: derived.address,
            providedAddress: address
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

/**
 * GET /api/history/:address - Get transaction history
 */
app.get('/api/history/:address', async (req, res) => {
    try {
        const response = await axios.get(
            `${WOC_BASE}/address/${req.params.address}/history`,
            { timeout: 10000 }
        );
        res.json({ success: true, history: response.data || [] });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║       BSV QUANTUM VAULT - SERVER             ║');
    console.log('║      Quantum-Resistant Hash-Lock Vault       ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Local:   http://localhost:${PORT}              ║`);
    console.log(`║  Network: http://0.0.0.0:${PORT}                ║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
});
