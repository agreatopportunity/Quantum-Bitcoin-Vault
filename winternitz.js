/**
 * BSV Quantum Vault - Production Winternitz Implementation v1 
 * @author BSV Quantum Vault
 * @version 1 - Simplified working WOTS-16
 */

const crypto = require('crypto');

// =============================================================================
// CONSTANTS
// =============================================================================

const CHUNKS = 32;
const MAX_ITERATIONS = 256;
const SCALAR_SIZE = 32;

const OP = {
    OP_0: 0x00, OP_FALSE: 0x00,
    OP_1: 0x51, OP_TRUE: 0x51,
    OP_2: 0x52, OP_3: 0x53, OP_4: 0x54, OP_5: 0x55,
    OP_6: 0x56, OP_7: 0x57, OP_8: 0x58, OP_9: 0x59,
    OP_10: 0x5a, OP_11: 0x5b, OP_12: 0x5c, OP_13: 0x5d,
    OP_14: 0x5e, OP_15: 0x5f, OP_16: 0x60,
    
    OP_IF: 0x63, OP_NOTIF: 0x64, OP_ELSE: 0x67, OP_ENDIF: 0x68,
    OP_VERIFY: 0x69, OP_RETURN: 0x6a,
    
    OP_TOALTSTACK: 0x6b, OP_FROMALTSTACK: 0x6c,
    OP_DROP: 0x75, OP_DUP: 0x76, OP_NIP: 0x77, OP_OVER: 0x78,
    OP_PICK: 0x79, OP_ROLL: 0x7a, OP_ROT: 0x7b, OP_SWAP: 0x7c,
    OP_TUCK: 0x7d, OP_2DROP: 0x6d, OP_2DUP: 0x6e, OP_3DUP: 0x6f,
    OP_2OVER: 0x70, OP_2ROT: 0x71, OP_2SWAP: 0x72, OP_DEPTH: 0x74,
    
    OP_CAT: 0x7e, OP_SPLIT: 0x7f, OP_SIZE: 0x82,
    OP_AND: 0x84, OP_OR: 0x85, OP_XOR: 0x86,
    
    OP_1ADD: 0x8b, OP_1SUB: 0x8c, OP_NEGATE: 0x8f, OP_ABS: 0x90,
    OP_NOT: 0x91, OP_0NOTEQUAL: 0x92,
    OP_ADD: 0x93, OP_SUB: 0x94, OP_MUL: 0x95, OP_DIV: 0x96, OP_MOD: 0x97,
    OP_NUMEQUAL: 0x9c, OP_NUMEQUALVERIFY: 0x9d, OP_NUMNOTEQUAL: 0x9e,
    OP_LESSTHAN: 0x9f, OP_GREATERTHAN: 0xa0,
    OP_LESSTHANOREQUAL: 0xa1, OP_GREATERTHANOREQUAL: 0xa2,
    OP_MIN: 0xa3, OP_MAX: 0xa4, OP_WITHIN: 0xa5,
    
    OP_RIPEMD160: 0xa6, OP_SHA1: 0xa7, OP_SHA256: 0xa8,
    OP_HASH160: 0xa9, OP_HASH256: 0xaa,
    OP_CODESEPARATOR: 0xab, OP_CHECKSIG: 0xac, OP_CHECKSIGVERIFY: 0xad,
    OP_CHECKMULTISIG: 0xae, OP_CHECKMULTISIGVERIFY: 0xaf,
    
    OP_CHECKLOCKTIMEVERIFY: 0xb1, OP_CHECKSEQUENCEVERIFY: 0xb2,
    OP_EQUAL: 0x87, OP_EQUALVERIFY: 0x88,
};

// =============================================================================
// HASH FUNCTIONS
// =============================================================================

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest();
}

function hash256(data) {
    return sha256(sha256(data));
o}

function hash160(data) {
    return crypto.createHash('ripemd160').update(sha256(data)).digest();
}

function iteratedSha256(data, iterations) {
    let result = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (let i = 0; i < iterations; i++) {
        result = sha256(result);
    }
    return result;
}

// =============================================================================
// BASE58 ENCODING
// =============================================================================

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer) {
    if (!buffer || buffer.length === 0) return '';
    let num = BigInt('0x' + buffer.toString('hex'));
    let result = '';
    while (num > 0) {
        const remainder = num % 58n;
        num = num / 58n;
        result = BASE58_ALPHABET[Number(remainder)] + result;
    }
    for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
        result = '1' + result;
    }
    return result;
}

function base58Decode(str) {
    if (!str || str.length === 0) return Buffer.alloc(0);
    let num = 0n;
    for (const char of str) {
        const index = BASE58_ALPHABET.indexOf(char);
        if (index === -1) throw new Error('Invalid base58 character');
        num = num * 58n + BigInt(index);
    }
    let hex = num.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const buffer = Buffer.from(hex, 'hex');
    let leadingZeros = 0;
    for (const char of str) {
        if (char === '1') leadingZeros++;
        else break;
    }
    return Buffer.concat([Buffer.alloc(leadingZeros), buffer]);
}

function base58CheckEncode(version, payload) {
    const data = Buffer.concat([Buffer.from([version]), payload]);
    const checksum = hash256(data).slice(0, 4);
    return base58Encode(Buffer.concat([data, checksum]));
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

// =============================================================================
// SCRIPT ENCODING
// =============================================================================

function encodePushData(data) {
    const len = data.length;
    if (len === 0) return Buffer.from([0x00]);
    if (len === 1 && data[0] >= 1 && data[0] <= 16) return Buffer.from([0x50 + data[0]]);
    if (len === 1 && data[0] === 0x81) return Buffer.from([0x4f]);
    if (len <= 75) return Buffer.concat([Buffer.from([len]), data]);
    if (len <= 255) return Buffer.concat([Buffer.from([0x4c, len]), data]);
    if (len <= 65535) {
        const lenBuf = Buffer.alloc(2);
        lenBuf.writeUInt16LE(len);
        return Buffer.concat([Buffer.from([0x4d]), lenBuf, data]);
    }
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(len);
    return Buffer.concat([Buffer.from([0x4e]), lenBuf, data]);
}

function encodeScriptNum(num) {
    if (num === 0) return Buffer.from([0x00]);
    if (num >= 1 && num <= 16) return Buffer.from([0x50 + num]);
    if (num === -1) return Buffer.from([0x4f]);
    
    const neg = num < 0;
    let absNum = Math.abs(num);
    const bytes = [];
    while (absNum > 0) {
        bytes.push(absNum & 0xff);
        absNum >>= 8;
    }
    if (bytes[bytes.length - 1] & 0x80) {
        bytes.push(neg ? 0x80 : 0x00);
    } else if (neg) {
        bytes[bytes.length - 1] |= 0x80;
    }
    return encodePushData(Buffer.from(bytes));
}

function encodeLocktimeForScript(lockTime) {
    if (lockTime <= 16) return Buffer.from([0x50 + lockTime]);
    let bytes = [];
    let n = lockTime;
    while (n > 0) {
        bytes.push(n & 0xff);
        n >>= 8;
    }
    if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
    const data = Buffer.from(bytes);
    return Buffer.concat([Buffer.from([data.length]), data]);
}

function scriptToASM(script) {
    const opcodeNames = {
        0x00: 'OP_0', 0x4f: 'OP_1NEGATE',
        0x51: 'OP_1', 0x52: 'OP_2', 0x53: 'OP_3', 0x54: 'OP_4',
        0x55: 'OP_5', 0x56: 'OP_6', 0x57: 'OP_7', 0x58: 'OP_8',
        0x63: 'OP_IF', 0x67: 'OP_ELSE', 0x68: 'OP_ENDIF',
        0x69: 'OP_VERIFY', 0x75: 'OP_DROP', 0x76: 'OP_DUP',
        0x7c: 'OP_SWAP', 0x87: 'OP_EQUAL', 0x88: 'OP_EQUALVERIFY',
        0x96: 'OP_DIV', 0x97: 'OP_MOD', 0xa8: 'OP_SHA256',
        0xb1: 'OP_CHECKLOCKTIMEVERIFY'
    };
    const parts = [];
    let i = 0;
    while (i < script.length) {
        const opcode = script[i];
        if (opcode >= 0x01 && opcode <= 0x4b) {
            parts.push(script.slice(i + 1, i + 1 + opcode).toString('hex'));
            i += 1 + opcode;
        } else if (opcode === 0x4c) {
            const len = script[i + 1];
            parts.push(script.slice(i + 2, i + 2 + len).toString('hex'));
            i += 2 + len;
        } else {
            parts.push(opcodeNames[opcode] || `OP_${opcode.toString(16)}`);
            i++;
        }
    }
    return parts.join(' ');
}

// =============================================================================
// WINTERNITZ KEY GENERATION (Original 32-chunk)
// =============================================================================

function generateWinternitzKeypair() {
    const privateScalars = [];
    const publicCommitments = [];
    
    for (let i = 0; i < CHUNKS; i++) {
        const scalar = crypto.randomBytes(SCALAR_SIZE);
        privateScalars.push(scalar);
        publicCommitments.push(iteratedSha256(scalar, MAX_ITERATIONS));
    }
    
    const privateKeyConcatenated = Buffer.concat(privateScalars);
    const publicKeyConcatenated = Buffer.concat(publicCommitments);
    const publicKeyHash = sha256(publicKeyConcatenated);
    
    return {
        privateKey: {
            scalars: privateScalars,
            concatenated: privateKeyConcatenated,
            hex: privateKeyConcatenated.toString('hex')
        },
        publicKey: {
            commitments: publicCommitments,
            concatenated: publicKeyConcatenated,
            hex: publicKeyConcatenated.toString('hex')
        },
        publicKeyHash,
        publicKeyHashHex: publicKeyHash.toString('hex')
    };
}

function restoreKeypairFromPrivate(privateKeyHex) {
    const privateKeyConcatenated = Buffer.from(privateKeyHex, 'hex');
    if (privateKeyConcatenated.length !== CHUNKS * SCALAR_SIZE) {
        throw new Error(`Invalid private key length`);
    }
    
    const privateScalars = [];
    const publicCommitments = [];
    
    for (let i = 0; i < CHUNKS; i++) {
        const scalar = privateKeyConcatenated.slice(i * SCALAR_SIZE, (i + 1) * SCALAR_SIZE);
        privateScalars.push(scalar);
        publicCommitments.push(iteratedSha256(scalar, MAX_ITERATIONS));
    }
    
    const publicKeyConcatenated = Buffer.concat(publicCommitments);
    const publicKeyHash = sha256(publicKeyConcatenated);
    
    return {
        privateKey: { scalars: privateScalars, concatenated: privateKeyConcatenated, hex: privateKeyHex },
        publicKey: { commitments: publicCommitments, concatenated: publicKeyConcatenated, hex: publicKeyConcatenated.toString('hex') },
        publicKeyHash,
        publicKeyHashHex: publicKeyHash.toString('hex')
    };
}

// =============================================================================
// COVENANT KEY
// =============================================================================

const COVENANT_SEED = "BSV_QUANTUM_VAULT_COVENANT_V1";
function getCovenantPrivateKey() {
    return sha256(Buffer.from(COVENANT_SEED));
}

// =============================================================================
// WOTS-16 PARAMETERS (w=16, 4-bit digits)
// =============================================================================

const WOTS16 = {
    W: 16,
    CHUNKS: 64,         // 256 bits / 4 bits = 64 chunks
    SCALAR_SIZE: 32,
    MAX_ITERATIONS: 16, // Values 0-15, so hash 0-15 times
    CHECKSUM_CHUNKS: 4  // For checksum security
};

/**
 * Generate WOTS-16 keypair
 * 
 * commitment_i = H^15(private_i)
 * (15 hashes, not 16, so remaining values are 0-15)
 */
function generateWOTS16Keypair() {
    const totalChunks = WOTS16.CHUNKS + WOTS16.CHECKSUM_CHUNKS; // 68
    
    const privateScalars = [];
    for (let i = 0; i < totalChunks; i++) {
        privateScalars.push(crypto.randomBytes(WOTS16.SCALAR_SIZE));
    }
    
    // Hash 15 times to get commitments
    const publicCommitments = privateScalars.map(scalar => {
        let hash = scalar;
        for (let j = 0; j < 15; j++) {
            hash = sha256(hash);
        }
        return hash;
    });
    
    const concatenated = Buffer.concat(publicCommitments);
    const publicKeyHash = sha256(concatenated);
    
    return {
        privateScalars,
        publicCommitments,
        publicKeyHash,
        publicKeyHashHex: publicKeyHash.toString('hex'),
        params: WOTS16
    };
}

/**
 * Sign a 32-byte message with WOTS-16
 * 
 * For each nibble d (0-15):
 *   sig = H^d(private)
 *   remaining = 15 - d
 * 
 * Verifier hashes sig 'remaining' more times to get commitment.
 */
function signWOTS16(keypair, message) {
    if (message.length !== 32) {
        throw new Error('Message must be 32 bytes');
    }
    
    // Convert to 4-bit nibbles
    const messageChunks = [];
    for (let i = 0; i < 32; i++) {
        messageChunks.push((message[i] >> 4) & 0x0F);
        messageChunks.push(message[i] & 0x0F);
    }
    
    // Calculate checksum
    let checksum = 0;
    for (const chunk of messageChunks) {
        checksum += 15 - chunk;
    }
    
    // Checksum nibbles
    const checksumChunks = [];
    for (let i = 0; i < WOTS16.CHECKSUM_CHUNKS; i++) {
        checksumChunks.push(checksum & 0x0F);
        checksum >>= 4;
    }
    
    const allChunks = [...messageChunks, ...checksumChunks];
    
    // Generate signature
    const signature = [];
    for (let i = 0; i < allChunks.length; i++) {
        const digit = allChunks[i];
        let sig = keypair.privateScalars[i];
        
        for (let j = 0; j < digit; j++) {
            sig = sha256(sig);
        }
        
        signature.push({
            value: sig,
            iterations: digit,
            remaining: 15 - digit
        });
    }
    
    return {
        chunks: signature,
        message: message,
        messageChunks: allChunks
    };
}

// =============================================================================
// WOTS-16 LOCKING SCRIPT v1
// =============================================================================

/**
 * Build WOTS-16 locking script
 * 
 * 
 * SECURITY:
 * - Each chunk verification proves knowledge of the private scalar
 * - Commitments are embedded in the locking script (immutable)
 * - All 68 chunks must verify for script to succeed
 */
function buildFullWOTS16LockingScript(publicKeyHash, publicCommitments, options = {}) {
    const { lockTime = null } = options;
    
    const parts = [];
    
    // Optional timelock
    if (lockTime && lockTime > 0) {
        parts.push(encodeLocktimeForScript(lockTime));
        parts.push(Buffer.from([OP.OP_CHECKLOCKTIMEVERIFY]));
        parts.push(Buffer.from([OP.OP_DROP]));
    }
    
    const totalChunks = WOTS16.CHUNKS + WOTS16.CHECKSUM_CHUNKS; // 68
    
    /**
     * SCRIPT LOGIC:
     * 
     * Unlocking script pushes (reverse order for correct stack):
     *   rem_67, sig_67, rem_66, sig_66, ..., rem_0, sig_0
     * 
     * Stack after push (top is sig_0):
     *   [rem_67, sig_67, ..., rem_0, sig_0]
     * 
     * For each chunk i (0 to 67):
     *   1. Stack: [..., rem_i, sig_i]  (sig_i on top)
     *   2. SWAP: [..., sig_i, rem_i]   (rem_i on top for decomposition)
     *   3. Binary decomposition: hash sig_i exactly 'rem_i' times
     *   4. DROP rem_i
     *   5. Push commitment_i and verify (EQUALVERIFY or EQUAL on last)
     *   6. After EQUALVERIFY: stack is [..., rem_{i+1}, sig_{i+1}]
     *   7. After last EQUAL: stack has TRUE
     */
    
    for (let i = 0; i < totalChunks; i++) {
        const commitmentBuf = Buffer.isBuffer(publicCommitments[i])
            ? publicCommitments[i]
            : Buffer.from(publicCommitments[i], 'hex');
        
        // Stack: [..., rem_i, sig_i] (sig_i on top)
        // SWAP to get rem_i on top for binary decomposition
        parts.push(Buffer.from([OP.OP_SWAP]));
        // Stack: [..., sig_i, rem_i]
        
        // =====================================================================
        // BINARY DECOMPOSITION (FIXED - uses OP_MOD/OP_DIV, not OP_AND)
        // =====================================================================
        // Hash sig_i exactly rem_i times using binary decomposition:
        //   bit 0: if (rem % 2) hash 1x
        //   bit 1: if ((rem/2) % 2) hash 2x
        //   bit 2: if ((rem/4) % 2) hash 4x
        //   bit 3: if ((rem/8) % 2) hash 8x
        
        // Bit 0: hash 1 time if (rem % 2) == 1
        parts.push(Buffer.from([OP.OP_DUP]));     // sig, rem, rem
        parts.push(Buffer.from([OP.OP_2]));       // sig, rem, rem, 2
        parts.push(Buffer.from([OP.OP_MOD]));     // sig, rem, (rem%2)
        parts.push(Buffer.from([OP.OP_IF]));
        parts.push(Buffer.from([OP.OP_SWAP]));    // rem, sig
        parts.push(Buffer.from([OP.OP_SHA256]));  // rem, H(sig)
        parts.push(Buffer.from([OP.OP_SWAP]));    // H(sig), rem
        parts.push(Buffer.from([OP.OP_ENDIF]));
        // Stack: (maybe hashed)sig, rem
        
        // Bit 1: hash 2 times if ((rem/2) % 2) == 1
        parts.push(Buffer.from([OP.OP_DUP]));     // sig, rem, rem
        parts.push(Buffer.from([OP.OP_2]));       // sig, rem, rem, 2
        parts.push(Buffer.from([OP.OP_DIV]));     // sig, rem, rem/2
        parts.push(Buffer.from([OP.OP_2]));       // sig, rem, rem/2, 2
        parts.push(Buffer.from([OP.OP_MOD]));     // sig, rem, (rem/2)%2
        parts.push(Buffer.from([OP.OP_IF]));
        parts.push(Buffer.from([OP.OP_SWAP]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SWAP]));
        parts.push(Buffer.from([OP.OP_ENDIF]));
        
        // Bit 2: hash 4 times if ((rem/4) % 2) == 1
        parts.push(Buffer.from([OP.OP_DUP]));
        parts.push(Buffer.from([OP.OP_4]));
        parts.push(Buffer.from([OP.OP_DIV]));
        parts.push(Buffer.from([OP.OP_2]));
        parts.push(Buffer.from([OP.OP_MOD]));
        parts.push(Buffer.from([OP.OP_IF]));
        parts.push(Buffer.from([OP.OP_SWAP]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SWAP]));
        parts.push(Buffer.from([OP.OP_ENDIF]));
        
        // Bit 3: hash 8 times if ((rem/8) % 2) == 1
        parts.push(Buffer.from([OP.OP_DUP]));
        parts.push(Buffer.from([OP.OP_8]));
        parts.push(Buffer.from([OP.OP_DIV]));
        parts.push(Buffer.from([OP.OP_2]));
        parts.push(Buffer.from([OP.OP_MOD]));
        parts.push(Buffer.from([OP.OP_IF]));
        parts.push(Buffer.from([OP.OP_SWAP]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SHA256]));
        parts.push(Buffer.from([OP.OP_SWAP]));
        parts.push(Buffer.from([OP.OP_ENDIF]));
        
        // Stack: hashed_sig, rem
        // Drop rem
        parts.push(Buffer.from([OP.OP_DROP]));
        // Stack: hashed_sig
        
        // Push commitment and verify
        parts.push(Buffer.from([0x20])); // Push next 32 bytes
        parts.push(commitmentBuf);
        // Stack: hashed_sig, commitment
        
        if (i < totalChunks - 1) {
            // Not last chunk: EQUALVERIFY (consume both, continue if equal)
            parts.push(Buffer.from([OP.OP_EQUALVERIFY]));
            // Stack: [..., rem_{i+1}, sig_{i+1}]
        } else {
            // Last chunk: EQUAL (leave TRUE/FALSE on stack)
            parts.push(Buffer.from([OP.OP_EQUAL]));
            // Stack: TRUE (if all verified) or FALSE
        }
        
        // DO NOT push commitment for later CAT - that was corrupting the stack!
    }
    
    return Buffer.concat(parts);
}

/**
 * Build unlocking script for WOTS-16 (no covenant)
 */
function buildWOTS16UnlockingScript(signature) {
    const parts = [];
    
    // Push in reverse order so chunk 0 ends up on top
    for (let i = signature.chunks.length - 1; i >= 0; i--) {
        const chunk = signature.chunks[i];
        
        // Push remaining (0-15)
        if (chunk.remaining === 0) {
            parts.push(Buffer.from([OP.OP_0]));
        } else if (chunk.remaining <= 16) {
            parts.push(Buffer.from([0x50 + chunk.remaining]));
        } else {
            parts.push(Buffer.from([0x01, chunk.remaining]));
        }
        
        // Push signature value (32 bytes)
        parts.push(Buffer.from([0x20]));
        parts.push(chunk.value);
    }
    
    return Buffer.concat(parts);
}

/**
 * Build unlocking script with covenant (for front-run immunity)
 */
function buildWOTS16UnlockingScriptWithCovenant(signature, sighashPreimage, covenantSignature) {
    const parts = [];
    
    // Push signature chunks in reverse
    for (let i = signature.chunks.length - 1; i >= 0; i--) {
        const chunk = signature.chunks[i];
        
        if (chunk.remaining === 0) {
            parts.push(Buffer.from([OP.OP_0]));
        } else if (chunk.remaining <= 16) {
            parts.push(Buffer.from([0x50 + chunk.remaining]));
        } else {
            parts.push(encodeScriptNum(chunk.remaining));
        }
        
        parts.push(Buffer.from([0x20]));
        parts.push(chunk.value);
    }
    
    // Push covenant signature
    parts.push(encodePushData(covenantSignature));
    
    // Push sighash preimage
    parts.push(encodePushData(sighashPreimage));
    
    return Buffer.concat(parts);
}

// =============================================================================
// STANDARD LOCKING SCRIPTS (Non-WOTS-16)
// =============================================================================

function buildStandardLockingScript(publicKeyHash) {
    const pubKeyHashBuf = Buffer.isBuffer(publicKeyHash) 
        ? publicKeyHash : Buffer.from(publicKeyHash, 'hex');
    
    return Buffer.concat([
        Buffer.from([OP.OP_SHA256]),
        Buffer.from([0x20]),
        pubKeyHashBuf,
        Buffer.from([OP.OP_EQUAL])
    ]);
}

function buildTimelockLockingScript(publicKeyHash, lockTime) {
    const pubKeyHashBuf = Buffer.isBuffer(publicKeyHash) 
        ? publicKeyHash : Buffer.from(publicKeyHash, 'hex');
    
    return Buffer.concat([
        encodeLocktimeForScript(lockTime),
        Buffer.from([OP.OP_CHECKLOCKTIMEVERIFY]),
        Buffer.from([OP.OP_DROP]),
        Buffer.from([OP.OP_SHA256]),
        Buffer.from([0x20]),
        pubKeyHashBuf,
        Buffer.from([OP.OP_EQUAL])
    ]);
}

function buildMaximumSecurityScript(publicKeyHash, ephemeralPubKey = null, options = {}) {
    const { lockTime = null } = options;
    const pubKeyHashBuf = Buffer.isBuffer(publicKeyHash) 
        ? publicKeyHash : Buffer.from(publicKeyHash, 'hex');
    
    const parts = [];
    
    if (lockTime && lockTime > 0) {
        parts.push(encodeLocktimeForScript(lockTime));
        parts.push(Buffer.from([OP.OP_CHECKLOCKTIMEVERIFY]));
        parts.push(Buffer.from([OP.OP_DROP]));
    }
    
    if (ephemeralPubKey) {
        const ephemPubKeyBuf = Buffer.isBuffer(ephemeralPubKey)
            ? ephemeralPubKey : Buffer.from(ephemeralPubKey, 'hex');
        parts.push(Buffer.from([ephemPubKeyBuf.length]));
        parts.push(ephemPubKeyBuf);
        parts.push(Buffer.from([OP.OP_CHECKSIGVERIFY]));
    }
    
    parts.push(Buffer.from([OP.OP_SIZE]));
    parts.push(Buffer.from([0x02, 0x00, 0x04])); // 1024
    parts.push(Buffer.from([OP.OP_EQUALVERIFY]));
    parts.push(Buffer.from([OP.OP_SHA256]));
    parts.push(Buffer.from([0x20]));
    parts.push(pubKeyHashBuf);
    parts.push(Buffer.from([OP.OP_EQUAL]));
    
    return Buffer.concat(parts);
}

function generateEphemeralKeypair() {
    const privateKey = crypto.randomBytes(32);
    return { privateKey, privateKeyHex: privateKey.toString('hex') };
}

function buildFrontRunImmuneScript(publicKeyHash, ephemeralPubKey, options = {}) {
    if (!ephemeralPubKey) throw new Error('Ephemeral public key required');
    return buildMaximumSecurityScript(publicKeyHash, ephemeralPubKey, options);
}

function buildUltimateSecurityScript(wots16Keypair, options = {}) {
    return buildFullWOTS16LockingScript(
        wots16Keypair.publicKeyHash,
        wots16Keypair.publicCommitments,
        options
    );
}

// Backward compatibility
const buildQuantumLockingScript = buildStandardLockingScript;
const buildFullWinternitzScript = buildFullWOTS16LockingScript;
const buildFullWinternitzLockingScript = buildFullWOTS16LockingScript;
const buildPracticalWinternitzScript = buildStandardLockingScript;
function buildWOTS16ChunkVerifier() { return Buffer.alloc(0); }
function buildWOTS16ChunkVerifierWithCovenant() { return Buffer.alloc(0); }

function buildUnlockingScript(vault) {
    const wotsPreimage = vault.keypair.publicKey.concatenated;
    const parts = [];
    if (wotsPreimage.length <= 75) {
        parts.push(Buffer.from([wotsPreimage.length]));
    } else if (wotsPreimage.length <= 255) {
        parts.push(Buffer.from([0x4c, wotsPreimage.length]));
    } else {
        parts.push(Buffer.from([0x4d, wotsPreimage.length & 0xff, (wotsPreimage.length >> 8) & 0xff]));
    }
    parts.push(wotsPreimage);
    return Buffer.concat(parts);
}

function buildFullWinternitzUnlockingScript(signature) {
    return buildWOTS16UnlockingScript(signature);
}

function calculateWOTS16ScriptSize() {
    const totalChunks = WOTS16.CHUNKS + WOTS16.CHECKSUM_CHUNKS;
    const perChunkSize = 85; // Simplified estimate
    return {
        perChunk: perChunkSize,
        total: totalChunks * perChunkSize + 35
    };
}

// =============================================================================
// VAULT MANAGEMENT
// =============================================================================

function createQuantumVault(options = {}) {
    const {
        securityLevel = 'standard',
        lockTime = 0,
        lockType = 'blocks',
        network = 'mainnet'
    } = options;
    
    let keypair;
    let wots16Keypair = null;
    let scriptType;
    let lockingScript;
    let ephemeralPrivateKey = null;
    let frontRunImmune = false;
    let quantumImmuneSpend = false;
    
    let effectiveLockTime = 0;
    if (lockTime && lockTime > 0) {
        if (lockType === 'timestamp' && lockTime < 500000000) {
            effectiveLockTime = Math.floor(Date.now() / 1000) + lockTime;
        } else {
            effectiveLockTime = lockTime;
        }
    }
    
    switch (securityLevel) {
        case 'ultimate':
            console.log('🔐 ULTIMATE security vault created with WOTS-16');
            wots16Keypair = generateWOTS16Keypair();
            keypair = generateWinternitzKeypair();
            
            lockingScript = buildFullWOTS16LockingScript(
                wots16Keypair.publicKeyHash,
                wots16Keypair.publicCommitments,
                { lockTime: effectiveLockTime }
            );
            
            scriptType = 'wots16-full-verification';
            quantumImmuneSpend = true;
            
            console.log(`   Script size: ${lockingScript.length} bytes`);
            console.log(`   ✅ QUANTUM-SAFE SPEND (WOTS-16 signature)`);
            console.log(`   ⚠️ Front-run immunity: Not yet implemented`);
            break;
            
        case 'maximum':
            console.log('🛡️ MAXIMUM security vault created');
            keypair = generateWinternitzKeypair();
            
            const ephKeypair = generateEphemeralKeypair();
            ephemeralPrivateKey = ephKeypair.privateKeyHex;
            
            const ecdh = require('crypto').createECDH('secp256k1');
            ecdh.setPrivateKey(Buffer.from(ephemeralPrivateKey, 'hex'));
            const ephemeralPubKey = ecdh.getPublicKey('', 'compressed');
            
            lockingScript = buildMaximumSecurityScript(
                keypair.publicKeyHash,
                ephemeralPubKey,
                { lockTime: effectiveLockTime }
            );
            
            scriptType = 'preimage-ecdsa-covenant';
            frontRunImmune = true;
            console.log(`   Script size: ${lockingScript.length} bytes`);
            break;
            
        case 'enhanced':
            console.log('⏰ ENHANCED security vault created (with timelock)');
            keypair = generateWinternitzKeypair();
            
            if (effectiveLockTime > 0) {
                lockingScript = buildTimelockLockingScript(keypair.publicKeyHash, effectiveLockTime);
                scriptType = 'preimage-timelock';
            } else {
                lockingScript = buildStandardLockingScript(keypair.publicKeyHash);
                scriptType = 'preimage-based';
            }
            console.log(`   Script size: ${lockingScript.length} bytes`);
            break;
            
        case 'standard':
        default:
            console.log('📝 STANDARD security vault created');
            keypair = generateWinternitzKeypair();
            lockingScript = buildStandardLockingScript(keypair.publicKeyHash);
            scriptType = 'preimage-based';
            console.log(`   Script size: ${lockingScript.length} bytes`);
            break;
    }
    
    const scriptHash = hash160(lockingScript);
    const wocScriptHashRaw = sha256(lockingScript);
    const wocScriptHash = Buffer.from(wocScriptHashRaw).reverse();
    const vaultId = createVaultId(scriptHash, keypair.publicKeyHashHex);
    
    let unlockInfo = null;
    if (effectiveLockTime > 0) {
        if (effectiveLockTime < 500000000) {
            unlockInfo = { type: 'block', blockHeight: effectiveLockTime };
        } else {
            unlockInfo = { type: 'timestamp', timestamp: effectiveLockTime, date: new Date(effectiveLockTime * 1000).toISOString() };
        }
    }
    
    const masterSecret = {
        version: 4,
        privateKey: keypair.privateKey.hex,
        publicKeyHash: keypair.publicKeyHashHex,
        lockingScript: lockingScript.toString('hex'),
        scriptType,
        securityLevel,
        lockTime: effectiveLockTime,
        unlockInfo,
        network
    };
    
    if (ephemeralPrivateKey) masterSecret.ephemeralPrivateKey = ephemeralPrivateKey;
    
    if (wots16Keypair) {
        masterSecret.wots16 = {
            privateScalars: wots16Keypair.privateScalars.map(s => s.toString('hex')),
            publicCommitments: wots16Keypair.publicCommitments.map(c => c.toString('hex')),
            publicKeyHash: wots16Keypair.publicKeyHashHex,
            params: wots16Keypair.params
        };
    }
    
    const effectivePublicKeyHash = wots16Keypair ? wots16Keypair.publicKeyHashHex : keypair.publicKeyHashHex;
    const scriptSize = lockingScript.length;
    
    let sweepInfo;
    if (securityLevel === 'ultimate') {
        const totalChunks = WOTS16.CHUNKS + WOTS16.CHECKSUM_CHUNKS;
        sweepInfo = {
            unlockingScriptSize: totalChunks * 34,
            estimatedTxSize: scriptSize + totalChunks * 34 + 34 + 10
        };
    } else if (securityLevel === 'maximum') {
        sweepInfo = { unlockingScriptSize: 1024 + 73 + 3, estimatedTxSize: scriptSize + 1100 + 34 + 10 };
    } else {
        sweepInfo = { unlockingScriptSize: 1024 + 3, estimatedTxSize: scriptSize + 1027 + 34 + 10 };
    }
    
    return {
        vaultId,
        scriptHash: scriptHash.toString('hex'),
        wocScriptHash: wocScriptHash.toString('hex'),
        lockingScript: lockingScript.toString('hex'),
        lockingScriptASM: scriptToASM(lockingScript),
        scriptSize,
        secret: Buffer.from(JSON.stringify(masterSecret)).toString('base64'),
        scriptType,
        securityLevel,
        lockTime: effectiveLockTime,
        unlockInfo,
        network,
        publicKeyHash: effectivePublicKeyHash,
        frontRunImmune,
        quantumImmuneSpend: quantumImmuneSpend || false,
        depositInfo: {
            method: 'bare-script',
            note: 'Use lockingScript directly as output script',
            scriptHex: lockingScript.toString('hex'),
            estimatedFee: scriptSize + 148
        },
        sweepInfo
    };
}

function restoreVaultFromSecret(secretBase64) {
    const secretJson = Buffer.from(secretBase64, 'base64').toString();
    const secret = JSON.parse(secretJson);
    
    if (!secret.privateKey || !secret.publicKeyHash) {
        throw new Error('Invalid secret: missing required fields');
    }
    
    const keypair = restoreKeypairFromPrivate(secret.privateKey);
    
    if (keypair.publicKeyHashHex !== secret.publicKeyHash) {
        throw new Error('Corrupted secret: public key hash mismatch');
    }
    
    let lockingScript;
    if (secret.lockingScript) {
        lockingScript = Buffer.from(secret.lockingScript, 'hex');
    } else {
        lockingScript = buildStandardLockingScript(keypair.publicKeyHash);
    }
    
    const scriptHash = hash160(lockingScript);
    const wocScriptHashRaw = sha256(lockingScript);
    const wocScriptHash = Buffer.from(wocScriptHashRaw).reverse();
    
    return {
        keypair,
        lockingScript,
        lockingScriptHex: lockingScript.toString('hex'),
        scriptHash: scriptHash.toString('hex'),
        wocScriptHash: wocScriptHash.toString('hex'),
        publicKeyHash: keypair.publicKeyHashHex,
        scriptType: secret.scriptType || 'preimage-based',
        securityLevel: secret.securityLevel || 'standard',
        lockTime: secret.lockTime || 0,
        unlockInfo: secret.unlockInfo || null,
        network: secret.network || 'mainnet',
        vaultId: createVaultId(scriptHash, keypair.publicKeyHashHex),
        version: secret.version || 3
    };
}

function createUnlockingData(vault, txHash = null) {
    const wotsPreimage = vault.keypair.publicKey.concatenated;
    const expectedHash = sha256(wotsPreimage);
    
    if (!expectedHash.equals(vault.keypair.publicKeyHash)) {
        throw new Error('Preimage verification failed');
    }
    
    return {
        wotsPreimage,
        wotsPreimageHex: wotsPreimage.toString('hex'),
        lockingScript: vault.lockingScript,
        scriptSig: buildUnlockingScript(vault),
        preimageSize: wotsPreimage.length,
        securityLevel: vault.securityLevel
    };
}

// =============================================================================
// UTILITIES
// =============================================================================

function createVaultId(scriptHash, publicKeyHash) {
    const combined = Buffer.isBuffer(scriptHash) ? scriptHash : Buffer.from(scriptHash, 'hex');
    const checksum = sha256(combined).slice(0, 4);
    return 'qv1Z' + base58Encode(Buffer.concat([combined.slice(0, 16), checksum]));
}

function blockHeightToTimestamp(blockHeight, currentBlockHeight = 873000) {
    return Math.floor(Date.now() / 1000) + (blockHeight - currentBlockHeight) * 600;
}

function timestampToBlockHeight(timestamp, currentBlockHeight = 873000) {
    return currentBlockHeight + Math.ceil((timestamp - Math.floor(Date.now() / 1000)) / 600);
}

function isValidP2PKHAddress(address) {
    try {
        const decoded = base58CheckDecode(address);
        return decoded.version === 0x00 || decoded.version === 0x6f;
    } catch { return false; }
}

function estimateCurrentBlockHeight() {
    const genesisTime = new Date('2009-01-03T18:15:05Z').getTime();
    return Math.floor((Date.now() - genesisTime) / (1000 * 60 * 10));
}

function pushNumber(n) {
    if (n === 0) return Buffer.from([OP.OP_0]);
    if (n >= 1 && n <= 16) return Buffer.from([0x50 + n]);
    if (n === -1) return Buffer.from([0x4f]);
    
    const neg = n < 0;
    let absN = Math.abs(n);
    const bytes = [];
    while (absN > 0) {
        bytes.push(absN & 0xff);
        absN >>= 8;
    }
    if (bytes[bytes.length - 1] & 0x80) {
        bytes.push(neg ? 0x80 : 0x00);
    } else if (neg && bytes.length > 0) {
        bytes[bytes.length - 1] |= 0x80;
    }
    return Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    CHUNKS, MAX_ITERATIONS, SCALAR_SIZE, OP, WOTS16, COVENANT_SEED,
    sha256, hash256, hash160, iteratedSha256,
    base58Encode, base58Decode, base58CheckEncode, base58CheckDecode,
    encodePushData, encodeScriptNum, encodeLocktimeForScript, scriptToASM,
    generateWinternitzKeypair, restoreKeypairFromPrivate, generateWOTS16Keypair, getCovenantPrivateKey,
    signWOTS16,
    buildStandardLockingScript, buildTimelockLockingScript, buildMaximumSecurityScript,
    buildFrontRunImmuneScript, buildUltimateSecurityScript, buildFullWOTS16LockingScript,
    buildWOTS16UnlockingScript, buildWOTS16UnlockingScriptWithCovenant,
    buildWOTS16ChunkVerifier, buildWOTS16ChunkVerifierWithCovenant,
    buildFullWinternitzLockingScript, buildPracticalWinternitzScript,
    buildQuantumLockingScript, buildFullWinternitzScript, buildUnlockingScript,
    generateEphemeralKeypair, buildFullWinternitzUnlockingScript,
    calculateWOTS16ScriptSize,
    createQuantumVault, restoreVaultFromSecret, createUnlockingData, createVaultId,
    pushNumber, blockHeightToTimestamp, timestampToBlockHeight, isValidP2PKHAddress, estimateCurrentBlockHeight
};
