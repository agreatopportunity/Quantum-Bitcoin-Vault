# BSV Quantum Vault ⚛️

A quantum-resistant vault for Bitcoin SV using SHA256 hash-lock (P2SH) technology.

## 🔐 How It Works

Instead of ECDSA signatures (which are vulnerable to quantum computers), your funds are secured by a **SHA256 hash preimage**. To spend, you reveal the secret that produces the hash.

### The Script

```
Locking Script (redeemScript):
OP_SHA256 <32-byte-hash> OP_EQUAL

Hex: a8 20 <hash> 87

Unlocking Script (scriptSig):
<32-byte-secret> <redeemScript>
```

### Security Model

| Attack Vector | ECDSA Wallet | Quantum Vault |
|---------------|--------------|---------------|
| Quantum Computer (Shor's Algorithm) | ❌ Vulnerable | ✅ Safe |
| Brute Force Secret | N/A | ✅ 2^256 attempts needed |
| Transaction Replay | ❌ Possible | ✅ One-time use |

## 🚀 Quick Start

### Installation

```bash
cd bsv-quantum-vault
npm install
```

### Run Server

```bash
npm start
```

Open http://localhost:3000 in your browser.

### Development Mode

```bash
npm run dev
```

## 📡 API Endpoints

### Create Vault
```
GET /api/create

Response:
{
  "success": true,
  "secret": "64-char-hex-secret",
  "secretHash": "64-char-hex-hash",
  "address": "3xxxxx...",  // P2SH address
  "redeemScript": "a820...87",
  "lockingScriptASM": "OP_SHA256 <hash> OP_EQUAL"
}
```

### Check Balance
```
POST /api/balance
Body: { "secret": "..." } or { "address": "..." }

Response:
{
  "success": true,
  "balance": 100000,  // satoshis
  "bsv": "0.00100000",
  "usd": "0.05",
  "address": "3xxx..."
}
```

### Sweep Funds
```
POST /api/sweep
Body: { "secret": "...", "toAddress": "1xxx..." }

Response:
{
  "success": true,
  "txid": "...",
  "explorerLink": "https://whatsonchain.com/tx/..."
}
```

## 🔧 Configuration

Environment variables (optional):

```bash
PORT=3000                    # Server port
```

The server uses:
- **WhatsOnChain API** for balance/UTXO queries
- **TAAL** for transaction broadcasting (with WoC fallback)

## 📂 Project Structure

```
bsv-quantum-vault/
├── server.js          # Node.js backend
├── package.json       # Dependencies
├── public/
│   ├── index.html     # Frontend HTML
│   ├── app.js         # Frontend JavaScript
│   └── styles.css     # Styling
└── README.md
```

## ⚠️ Security Notes

1. **SAVE YOUR SECRET** - The 64-character hex secret is the ONLY way to access funds
2. **One-Time Use** - Each vault should only be swept once
3. **Test First** - Send small amounts first to verify everything works
4. **Backup** - Store your secret in multiple secure locations

## 🔬 Technical Details

| Property | Value |
|----------|-------|
| Script Type | P2SH (Pay-to-Script-Hash) |
| Hash Algorithm | SHA256 |
| Secret Size | 256 bits (32 bytes) |
| Address Prefix | 3 (P2SH mainnet) |
| Network | BSV Mainnet |

## 📜 License

MIT License - Built for the Bitcoin SV ecosystem.

## 🔗 Links

- [WhatsOnChain Explorer](https://whatsonchain.com)
- [BSV Documentation](https://docs.bitcoinsv.io)
- [TAAL API](https://taal.com)
