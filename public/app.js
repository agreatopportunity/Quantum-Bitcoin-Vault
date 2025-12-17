/**
 * BSV Quantum Vault v3 - Frontend Application
 * 
 * Handles UI interactions and API communication for the quantum vault.
 */

// =============================================================================
// API HELPERS
// =============================================================================

async function apiRequest(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    try {
        const response = await fetch(endpoint, options);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('API Error:', error);
        return { success: false, error: 'Network error: ' + error.message };
    }
}

// =============================================================================
// QR CODE GENERATION
// =============================================================================

function generateQR(elementId, text) {
    const container = document.getElementById(elementId);
    if (!container) return;
    
    container.innerHTML = '';
    if (!text || text === '...') return;
    
    try {
        new QRCode(container, {
            text: text,
            width: 128,
            height: 128,
            colorDark: '#f7931a',
            colorLight: '#0a0f1a',
            correctLevel: QRCode.CorrectLevel.H
        });
    } catch (e) {
        console.error('QR generation error:', e);
    }
}

// =============================================================================
// VAULT OPTIONS UI HELPERS
// =============================================================================

/**
 * Toggle time-lock configuration visibility
 */
function toggleTimeLock() {
    const checkbox = document.getElementById('enableTimeLock');
    const config = document.getElementById('timeLockConfig');
    
    if (checkbox && config) {
        if (checkbox.checked) {
            config.classList.remove('hidden');
            // Set minimum date to tomorrow
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dateInput = document.getElementById('unlockDate');
            if (dateInput) {
                dateInput.min = tomorrow.toISOString().slice(0, 16);
            }
        } else {
            config.classList.add('hidden');
        }
    }
    
    updateSecurityInfo();
}

/**
 * Toggle between date and block height inputs
 */
function toggleLockTypeInput() {
    const lockType = document.querySelector('input[name="lockType"]:checked')?.value;
    const dateInput = document.getElementById('dateLockInput');
    const blockInput = document.getElementById('blockLockInput');
    
    if (lockType === 'date') {
        dateInput?.classList.remove('hidden');
        blockInput?.classList.add('hidden');
    } else {
        dateInput?.classList.add('hidden');
        blockInput?.classList.remove('hidden');
    }
}

/**
 * Update security info box based on selected options
 */
function updateSecurityInfo() {
    const securityLevel = document.querySelector('input[name="securityLevel"]:checked')?.value || 'standard';
    const timeLockEnabled = document.getElementById('enableTimeLock')?.checked;
    const infoBox = document.getElementById('securityInfo');
    
    if (!infoBox) return;
    
    let info = '';
    let className = 'info-box';
    
    switch (securityLevel) {
        case 'ultimate':
            info = `<strong>🔐 ULTIMATE Security - MATHEMATICALLY PERFECT:</strong> Full on-chain WOTS-16 verification. 
                    Signature verified entirely using quantum-resistant hash operations. No ECDSA at all - 
                    pure post-quantum security. ~8-10KB script, ~2.5KB unlock. <em>ABSOLUTE</em> protection 
                    against ALL attackers, classical and quantum, now and forever.`;
            className = 'info-box info-ultimate';
            break;
        case 'maximum':
            info = `<strong>🛡️ Maximum Security - Practical Front-Run Immunity:</strong> Uses ephemeral ECDSA covenant to bind 
                    transaction to your specific outputs. Attackers <em>cannot</em> create valid transactions 
                    to different addresses. ~80 byte script. Note: ECDSA could theoretically be broken by 
                    future quantum computers during ~10 min mempool window.`;
            className = 'info-box info-maximum';
            break;
        case 'enhanced':
            info = `<strong>🔐 Enhanced Security:</strong> Standard protection with optional time-lock. 
                    Funds cannot be spent until the specified time/block height. 
                    Perfect for inheritance, vesting, or forced HODL. ~45 byte script.`;
            className = 'info-box info-enhanced';
            break;
        case 'standard':
        default:
            info = `<strong>⚡ Standard Security:</strong> Simple SHA256 preimage check. Quantum-resistant for storage. 
                    Smallest script (~35 bytes), lowest fees. Recommended for most use cases.`;
            className = 'info-box info-standard';
            break;
    }
    
    if (timeLockEnabled) {
        info += `<br><br><strong>🔒 Time-Lock Enabled:</strong> Funds cannot be spent until the specified time/block. 
                 Perfect for inheritance planning, forced HODLing, or vesting schedules.`;
    }
    
    infoBox.innerHTML = info;
    infoBox.className = className;
}

/**
 * Initialize vault options on page load
 */
function initVaultOptions() {
    // Set up change listeners for security level radio buttons
    document.querySelectorAll('input[name="securityLevel"]').forEach(radio => {
        radio.addEventListener('change', updateSecurityInfo);
    });
    
    // Set minimum date for time-lock
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateInput = document.getElementById('unlockDate');
    if (dateInput) {
        dateInput.min = tomorrow.toISOString().slice(0, 16);
        // Default to 1 year from now
        const oneYearLater = new Date();
        oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
        dateInput.value = oneYearLater.toISOString().slice(0, 16);
    }
    
    // Estimate current block height
    const currentBlockSpan = document.getElementById('currentBlock');
    if (currentBlockSpan) {
        // BSV genesis: 2009-01-03, ~10 min blocks
        const genesisTime = new Date('2009-01-03T18:15:05Z').getTime();
        const now = Date.now();
        const elapsedMinutes = (now - genesisTime) / (1000 * 60);
        const estimatedBlock = Math.floor(elapsedMinutes / 10);
        currentBlockSpan.textContent = estimatedBlock.toLocaleString();
        
        // Set default block to ~1 year from now
        const blockInput = document.getElementById('unlockBlock');
        if (blockInput) {
            blockInput.placeholder = `e.g., ${estimatedBlock + 52560}`; // ~1 year
        }
    }
    
    // Initialize security info
    updateSecurityInfo();
}

// =============================================================================
// VAULT CREATION
// =============================================================================

/**
 * Create a new quantum vault with selected options
 */
async function createVault() {
    const btn = document.getElementById('createBtn');
    const resultDiv = document.getElementById('createResult');
    
    // Get selected security level
    const securityLevel = document.querySelector('input[name="securityLevel"]:checked')?.value || 'standard';
    
    // Get time-lock settings
    let lockTime = 0;
    let lockType = 'blocks';
    
    if (document.getElementById('enableTimeLock')?.checked) {
        const lockTypeValue = document.querySelector('input[name="lockType"]:checked')?.value || 'date';
        
        if (lockTypeValue === 'date') {
            const dateInput = document.getElementById('unlockDate')?.value;
            if (dateInput) {
                lockTime = Math.floor(new Date(dateInput).getTime() / 1000);
                lockType = 'timestamp';
            }
        } else {
            const blockInput = document.getElementById('unlockBlock')?.value;
            if (blockInput) {
                lockTime = parseInt(blockInput);
                lockType = 'blocks';
            }
        }
    }
    
    // Update button state
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon">⏳</span><span>Generating...</span>';
    
    try {
        // Build API URL with query parameters
        let url = `/api/create?security=${securityLevel}`;
        if (lockTime > 0) {
            url += `&lockTime=${lockTime}&lockType=${lockType}`;
        }
        
        const data = await apiRequest(url);
        
        if (data.success) {
            // Show result section
            resultDiv.classList.remove('hidden');
            
            // Populate values
            document.getElementById('vaultId').textContent = data.vaultId;
            document.getElementById('scriptHash').textContent = data.scriptHash;
            document.getElementById('lockingScriptASM').textContent = data.lockingScriptASM;
            document.getElementById('lockingScript').textContent = data.lockingScript;
            document.getElementById('vaultSecret').value = data.secret;
            
            // Update security badges
            if (data.security) {
                document.getElementById('sigType').textContent = data.security.signatureType || 'Winternitz OTS';
                document.getElementById('keyEntropy').textContent = data.security.keyEntropy || '1024 bytes';
            }
            
            // Scroll to result
            resultDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
            
            showNotification('✅ Quantum Vault Created Successfully!', 'success');
            
        } else {
            showNotification('❌ Error: ' + data.error, 'error');
        }
        
    } catch (error) {
        showNotification('❌ Error: ' + error.message, 'error');
    }
    
    // Reset button
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">⚡</span><span>Generate Vault</span>';
}

// =============================================================================
// BALANCE CHECK
// =============================================================================

async function checkBalance() {
    const secret = document.getElementById('inputSecret').value.trim();
    const statusDiv = document.getElementById('accessStatus');
    
    if (!secret) {
        showNotification('Please enter the vault master secret', 'warning');
        return;
    }
    
    // Validate secret format
    try {
        const decoded = atob(secret);
        JSON.parse(decoded);
    } catch (e) {
        statusDiv.innerHTML = '<div class="status-error">❌ Invalid secret format. Must be valid Base64-encoded JSON.</div>';
        return;
    }
    
    statusDiv.innerHTML = '<div class="status-loading">🔄 Checking balance on BSV blockchain...</div>';
    
    try {
        const data = await apiRequest('/api/balance', 'POST', { secret });
        
        if (data.success) {
            const canSweep = data.canSweep ? 
                '<span style="color: var(--accent-secondary)">✓ Ready to sweep</span>' : 
                '<span style="color: var(--warning)">⚠️ ' + data.sweepNote + '</span>';
            
            statusDiv.innerHTML = `
                <div class="status-success">
                    <div class="balance-display">
                        <span class="balance-amount">${data.balance.bsv} BSV</span>
                        <span class="balance-sats">${data.balance.satoshis.toLocaleString()} satoshis</span>
                    </div>
                    <div class="balance-usd">≈ $${data.balance.usd} USD @ $${data.price}/BSV</div>
                    <div style="margin-top: var(--spacing-md); text-align: center; font-size: 0.85rem;">
                        <div><strong>Vault:</strong> ${data.vaultId || data.scriptHash}</div>
                        <div><strong>UTXOs:</strong> ${data.utxoCount}</div>
                        <div>${canSweep}</div>
                        ${data.balance.unconfirmed > 0 ? 
                            `<div style="color: var(--warning)">⏳ Pending: ${data.balance.unconfirmed} sats</div>` : 
                            ''}
                    </div>
                </div>
            `;
        } else {
            statusDiv.innerHTML = `<div class="status-error">❌ ${data.error}</div>`;
        }
        
    } catch (error) {
        statusDiv.innerHTML = `<div class="status-error">❌ ${error.message}</div>`;
    }
}

// =============================================================================
// SWEEP VAULT
// =============================================================================

async function sweepVault() {
    const secret = document.getElementById('inputSecret').value.trim();
    const toAddress = document.getElementById('inputAddress').value.trim();
    const statusDiv = document.getElementById('accessStatus');
    
    // Validation
    if (!secret) {
        showNotification('Please enter the vault master secret', 'warning');
        return;
    }
    
    if (!toAddress) {
        showNotification('Please enter a destination address', 'warning');
        return;
    }
    
    if (!toAddress.startsWith('1')) {
        statusDiv.innerHTML = '<div class="status-error">❌ Destination must be a P2PKH address starting with "1"</div>';
        return;
    }
    
    // Validate secret format
    try {
        const decoded = atob(secret);
        JSON.parse(decoded);
    } catch (e) {
        statusDiv.innerHTML = '<div class="status-error">❌ Invalid secret format</div>';
        return;
    }
    
    // Confirm
    const confirmed = confirm(
        '⚠️ CONFIRM QUANTUM VAULT SWEEP\n\n' +
        'This will send ALL funds from the vault to:\n' +
        toAddress + '\n\n' +
        'This action is IRREVERSIBLE.\n' +
        'The vault uses a one-time signature - after this, the vault cannot be reused.\n\n' +
        'Continue?'
    );
    
    if (!confirmed) return;
    
    statusDiv.innerHTML = '<div class="status-loading">📡 Building and broadcasting transaction...</div>';
    
    try {
        const data = await apiRequest('/api/sweep', 'POST', { secret, toAddress });
        
        if (data.success) {
            statusDiv.innerHTML = `
                <div class="status-success">
                    <div style="text-align: center; margin-bottom: var(--spacing-md);">
                        <span style="font-size: 2rem;">✅</span>
                        <h3 style="margin-top: var(--spacing-sm);">Sweep Successful!</h3>
                    </div>
                    <div class="tx-details">
                        <div class="detail-row">
                            <span>TXID:</span>
                            <span class="mono" style="font-size: 0.75rem;">${data.txid}</span>
                        </div>
                        <div class="detail-row">
                            <span>Amount:</span>
                            <span>${(data.details.outputValue / 100000000).toFixed(8)} BSV</span>
                        </div>
                        <div class="detail-row">
                            <span>Fee:</span>
                            <span>${data.details.fee} sats</span>
                        </div>
                        <div class="detail-row">
                            <span>Size:</span>
                            <span>${data.details.size} bytes</span>
                        </div>
                        <div class="detail-row">
                            <span>Signature:</span>
                            <span>${data.details.signatureType}</span>
                        </div>
                        <div class="detail-row">
                            <span>Broadcast via:</span>
                            <span>${data.details.broadcastVia}</span>
                        </div>
                    </div>
                    <div style="text-align: center;">
                        <a href="${data.explorerLink}" target="_blank" class="explorer-link">
                            🔗 View on WhatsOnChain
                        </a>
                    </div>
                </div>
            `;
            
            showNotification('🎉 Funds swept successfully!', 'success');
            
        } else {
            statusDiv.innerHTML = `<div class="status-error">❌ ${data.error}</div>`;
        }
        
    } catch (error) {
        statusDiv.innerHTML = `<div class="status-error">❌ ${error.message}</div>`;
    }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    const text = element.value || element.textContent;
    
    if (!text || text === '...') {
        showNotification('Nothing to copy', 'warning');
        return;
    }
    
    navigator.clipboard.writeText(text).then(() => {
        showNotification('📋 Copied to clipboard!', 'success');
    }).catch(err => {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showNotification('📋 Copied!', 'success');
    });
}

function toggleDetails(id) {
    const element = document.getElementById(id);
    const icon = document.getElementById(id + 'Icon');
    
    if (element.classList.contains('expanded')) {
        element.classList.remove('expanded');
        if (icon) icon.textContent = '▼';
    } else {
        element.classList.add('expanded');
        if (icon) icon.textContent = '▲';
    }
}

function showNotification(message, type = 'info') {
    const container = document.getElementById('notificationContainer');
    
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    container.appendChild(notification);
    
    // Trigger animation
    setTimeout(() => notification.classList.add('show'), 10);
    
    // Auto-remove
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

function showInfo() {
    alert(
        '🔒 BSV QUANTUM VAULT v3.0 - SECURITY INFO\n\n' +
        '━━━ WINTERNITZ ONE-TIME SIGNATURE ━━━\n\n' +
        '• 32 random 32-byte scalars (1024 bytes total)\n' +
        '• Each scalar hashed 256 times → public commitment\n' +
        '• SHA256(all commitments) = public key hash\n\n' +
        '━━━ QUANTUM RESISTANCE ━━━\n\n' +
        '• NO ECDSA (vulnerable to Shor\'s algorithm)\n' +
        '• Security based entirely on hash functions\n' +
        '• SHA256 remains secure against quantum computers\n\n' +
        '━━━ BSV GENESIS COMPLIANCE ━━━\n\n' +
        '• Uses BARE SCRIPTS (not P2SH)\n' +
        '• P2SH was deprecated in Feb 2020\n' +
        '• Addresses starting with "3" don\'t work on BSV\n\n' +
        '━━━ IMPORTANT ━━━\n\n' +
        '• Your master secret is the ONLY way to access funds\n' +
        '• Store it securely OFFLINE\n' +
        '• Winternitz is ONE-TIME - vault cannot be reused after sweep'
    );
}

function showHelp() {
    alert(
        '📖 BSV QUANTUM VAULT - HELP\n\n' +
        '━━━ CREATING A VAULT ━━━\n\n' +
        '1. Click "Generate Vault"\n' +
        '2. SAVE the Master Secret immediately!\n' +
        '3. Click "Continue to Fund Vault"\n\n' +
        '━━━ FUNDING A VAULT (NEW!) ━━━\n\n' +
        'We\'ve made funding easy with QR codes!\n\n' +
        '1. Load your vault with the Master Secret\n' +
        '2. Scan the QR code with any BSV wallet\n' +
        '3. Send any amount to the displayed address\n' +
        '4. Click "Deposit to Quantum Vault"\n\n' +
        'The app automatically moves funds from the\n' +
        'temporary address to your quantum-resistant vault.\n\n' +
        '━━━ ACCESSING FUNDS ━━━\n\n' +
        '1. Paste your Master Secret\n' +
        '2. Check Balance to see available funds\n' +
        '3. Enter a P2PKH destination (starts with "1")\n' +
        '4. Click "Sweep Funds" to withdraw\n\n' +
        '━━━ IMPORTANT ━━━\n\n' +
        '• Winternitz signatures are ONE-TIME USE\n' +
        '• After sweeping, the vault cannot be reused\n' +
        '• Create a new vault for each deposit cycle'
    );
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    // Initialize vault options UI
    initVaultOptions();
    
    // Auto-expand script details if present
    const scriptDetails = document.getElementById('scriptDetails');
    if (scriptDetails) {
        // Start collapsed
        scriptDetails.classList.remove('expanded');
    }
    
    // Enter key handlers
    const addressInput = document.getElementById('inputAddress');
    if (addressInput) {
        addressInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sweepVault();
            }
        });
    }
});

// =============================================================================
// GLOBAL EXPORTS
// =============================================================================

window.createVault = createVault;
window.checkBalance = checkBalance;
window.sweepVault = sweepVault;
window.copyToClipboard = copyToClipboard;
window.toggleDetails = toggleDetails;
window.showInfo = showInfo;
window.showHelp = showHelp;

// New vault options exports
window.toggleTimeLock = toggleTimeLock;
window.toggleLockTypeInput = toggleLockTypeInput;
window.updateSecurityInfo = updateSecurityInfo;
window.initVaultOptions = initVaultOptions;

// =============================================================================
// FUNDING SYSTEM
// =============================================================================

let currentFundingData = null;
let currentFundingKeys = null;
let currentVaultSecret = null;
let fundingCheckInterval = null;

/**
 * Show the funding section after vault creation
 */
function showFundingSection() {
    const vaultSecret = document.getElementById('vaultSecret').value;
    
    if (!vaultSecret || vaultSecret === '...') {
        showNotification('Please create a vault first', 'warning');
        return;
    }
    
    // Store the secret
    currentVaultSecret = vaultSecret;
    
    // Show funding section
    const fundSection = document.getElementById('fundSection');
    fundSection.style.display = 'block';
    
    // Pre-fill the secret in the funding input
    document.getElementById('fundingSecretInput').value = vaultSecret;
    
    // Scroll to funding section
    fundSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    // Auto-load the vault
    loadVaultForFunding();
}

/**
 * Load vault for funding
 */
async function loadVaultForFunding() {
    const secret = document.getElementById('fundingSecretInput').value.trim();
    
    if (!secret) {
        showNotification('Please enter the vault master secret', 'warning');
        return;
    }
    
    // Validate secret format
    try {
        const decoded = atob(secret);
        JSON.parse(decoded);
    } catch (e) {
        showNotification('Invalid secret format', 'error');
        return;
    }
    
    currentVaultSecret = secret;
    
    // Verify vault and get info
    try {
        const data = await apiRequest('/api/verify', 'POST', { secret });
        
        if (data.success) {
            // Update vault info display
            document.getElementById('fundingVaultId').textContent = data.derived.vaultId;
            document.getElementById('fundingVaultInfo').style.display = 'block';
            
            // Generate funding address
            await generateFundingAddress();
            
            // Hide step 1, show step 2
            document.getElementById('fundStep1').classList.add('hidden');
            document.getElementById('fundStep2').classList.remove('hidden');
            
            showNotification('✅ Vault loaded successfully!', 'success');
            
        } else {
            showNotification('❌ Invalid vault secret', 'error');
        }
        
    } catch (error) {
        showNotification('❌ Error loading vault: ' + error.message, 'error');
    }
}

/**
 * Generate a funding address
 */
async function generateFundingAddress() {
    try {
        const data = await apiRequest('/api/generate-funding-address', 'POST', {});
        
        if (data.success) {
            currentFundingData = data.fundingData;
            currentFundingKeys = data.keys; // Store keys
            
            // Display the address
            document.getElementById('fundingAddressDisplay').textContent = data.fundingAddress;
            
            // Display the keys
            if (data.keys) {
                document.getElementById('fundingWIF').value = data.keys.privateKeyWIF;
                document.getElementById('fundingPrivKeyHex').value = data.keys.privateKeyHex;
                document.getElementById('fundingPubKeyHex').value = data.keys.publicKeyHex;
            }
            
            // Generate QR code
            const qrContainer = document.getElementById('fundingQR');
            qrContainer.innerHTML = '';
            
            new QRCode(qrContainer, {
                text: data.qrData,
                width: 200,
                height: 200,
                colorDark: '#f7931a',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.H
            });
            
            // Start auto-checking for balance
            startFundingBalanceCheck();
            
        } else {
            showNotification('❌ Error generating address: ' + data.error, 'error');
        }
        
    } catch (error) {
        showNotification('❌ Error: ' + error.message, 'error');
    }
}

/**
 * Toggle password visibility for key fields
 */
function toggleKeyVisibility(inputId) {
    const input = document.getElementById(inputId);
    if (input.type === 'password') {
        input.type = 'text';
    } else {
        input.type = 'password';
    }
}

/**
 * Start periodic balance checking
 */
function startFundingBalanceCheck() {
    // Clear any existing interval
    if (fundingCheckInterval) {
        clearInterval(fundingCheckInterval);
    }
    
    // Check immediately
    refreshFundingBalance();
    
    // Then check every 10 seconds
    fundingCheckInterval = setInterval(refreshFundingBalance, 10000);
}

/**
 * Refresh funding address balance
 */
async function refreshFundingBalance() {
    if (!currentFundingData) return;
    
    try {
        const data = await apiRequest('/api/check-funding', 'POST', {
            fundingData: currentFundingData
        });
        
        if (data.success) {
            const balanceContent = document.getElementById('fundingBalanceContent');
            
            if (data.balance.satoshis > 0) {
                balanceContent.innerHTML = `
                    <div class="balance-funded">
                        <span class="amount">${data.balance.bsv} BSV</span>
                        <span class="sats">${data.balance.satoshis.toLocaleString()} satoshis</span>
                        <span class="usd">≈ $${data.balance.usd} USD</span>
                        ${data.balance.unconfirmed > 0 ? 
                            `<span style="color: var(--warning);">⏳ ${data.balance.unconfirmed} sats unconfirmed</span>` : 
                            '<span style="color: var(--accent-secondary);">✓ Confirmed</span>'}
                    </div>
                `;
                
                // Show send elsewhere option
                document.getElementById('sendElsewhereSection').classList.remove('hidden');
                
                // Show step 3 if balance is sufficient
                if (data.readyToDeposit) {
                    document.getElementById('fundStep3').classList.remove('hidden');
                    document.getElementById('depositAmountDisplay').textContent = 
                        `${data.balance.bsv} BSV`;
                    
                    // Stop auto-checking once funds are detected
                    // (user will trigger deposit manually)
                }
            } else {
                balanceContent.innerHTML = '<div class="balance-zero">Waiting for deposit...</div>';
                // Hide send elsewhere if no balance
                document.getElementById('sendElsewhereSection').classList.add('hidden');
            }
        }
        
    } catch (error) {
        console.error('Balance check error:', error);
    }
}

/**
 * Deposit funds to the quantum vault
 */
async function depositToVault() {
    if (!currentFundingData || !currentVaultSecret) {
        showNotification('Missing funding data or vault secret', 'error');
        return;
    }
    
    const depositBtn = document.getElementById('depositBtn');
    const resultDiv = document.getElementById('depositResult');
    
    // Confirm
    const confirmed = confirm(
        '🚀 CONFIRM DEPOSIT TO QUANTUM VAULT\n\n' +
        'This will transfer funds from the temporary address into your quantum-resistant vault.\n\n' +
        'The funds will be protected by Winternitz one-time signatures.\n\n' +
        'Continue?'
    );
    
    if (!confirmed) return;
    
    // Update UI
    depositBtn.disabled = true;
    depositBtn.innerHTML = '<span class="btn-icon">⏳</span><span>Processing...</span>';
    resultDiv.innerHTML = '<div class="status-loading">📡 Building and broadcasting deposit transaction...</div>';
    
    try {
        const data = await apiRequest('/api/deposit-to-vault', 'POST', {
            fundingData: currentFundingData,
            vaultSecret: currentVaultSecret
        });
        
        if (data.success) {
            // Stop balance checking
            if (fundingCheckInterval) {
                clearInterval(fundingCheckInterval);
                fundingCheckInterval = null;
            }
            
            resultDiv.innerHTML = `
                <div class="status-success deposit-success">
                    <div class="icon">🎉</div>
                    <h3>Deposit Successful!</h3>
                    <p>Your funds are now secured in your quantum-resistant vault.</p>
                    
                    <div class="deposit-details">
                        <div class="row">
                            <span class="label">Transaction ID</span>
                            <span class="value mono">${data.txid}</span>
                        </div>
                        <div class="row">
                            <span class="label">Amount Deposited</span>
                            <span class="value">${(data.details.outputValue / 100000000).toFixed(8)} BSV</span>
                        </div>
                        <div class="row">
                            <span class="label">Network Fee</span>
                            <span class="value">${data.details.fee} sats</span>
                        </div>
                        <div class="row">
                            <span class="label">Target Vault</span>
                            <span class="value mono">${data.details.toVault}</span>
                        </div>
                        <div class="row">
                            <span class="label">Broadcast Via</span>
                            <span class="value">${data.details.broadcastVia}</span>
                        </div>
                    </div>
                    
                    <a href="${data.explorerLink}" target="_blank" class="explorer-link">
                        🔗 View on WhatsOnChain
                    </a>
                    
                    <div style="margin-top: var(--spacing-xl);">
                        <button class="btn btn-secondary" onclick="resetFunding()">
                            <span class="btn-icon">➕</span>
                            <span>Make Another Deposit</span>
                        </button>
                    </div>
                </div>
            `;
            
            showNotification('🎉 Deposit successful! Funds secured in quantum vault.', 'success');
            
        } else {
            throw new Error(data.error);
        }
        
    } catch (error) {
        resultDiv.innerHTML = `<div class="status-error">❌ Deposit failed: ${error.message}</div>`;
        showNotification('❌ Deposit failed: ' + error.message, 'error');
    }
    
    // Reset button
    depositBtn.disabled = false;
    depositBtn.innerHTML = '<span class="btn-icon">🚀</span><span>Deposit to Quantum Vault</span>';
}

/**
 * Reset funding for another deposit
 */
function resetFunding() {
    currentFundingData = null;
    currentFundingKeys = null;
    
    // Reset UI
    document.getElementById('fundStep2').classList.add('hidden');
    document.getElementById('fundStep3').classList.add('hidden');
    document.getElementById('fundStep1').classList.remove('hidden');
    document.getElementById('sendElsewhereSection').classList.add('hidden');
    document.getElementById('depositResult').innerHTML = '';
    document.getElementById('fundingBalanceContent').innerHTML = 
        '<div class="balance-zero">Waiting for deposit...</div>';
    document.getElementById('sendElsewhereAddress').value = '';
    
    // Reset key displays
    document.getElementById('fundingWIF').value = '...';
    document.getElementById('fundingPrivKeyHex').value = '...';
    document.getElementById('fundingPubKeyHex').value = '...';
    
    // Re-load vault to generate new funding address
    loadVaultForFunding();
}

/**
 * Send funds to a different address (not the vault)
 */
async function sendElsewhere() {
    const toAddress = document.getElementById('sendElsewhereAddress').value.trim();
    
    if (!toAddress) {
        showNotification('Please enter a destination address', 'warning');
        return;
    }
    
    if (!toAddress.startsWith('1')) {
        showNotification('Address must start with "1" (P2PKH)', 'error');
        return;
    }
    
    if (!currentFundingData) {
        showNotification('No funding data available', 'error');
        return;
    }
    
    // Confirm
    const confirmed = confirm(
        '📤 CONFIRM SEND TO DIFFERENT ADDRESS\n\n' +
        'This will send ALL funds from the temporary address to:\n' +
        toAddress + '\n\n' +
        'The funds will NOT go to your quantum vault.\n\n' +
        'Continue?'
    );
    
    if (!confirmed) return;
    
    const resultDiv = document.getElementById('depositResult');
    resultDiv.innerHTML = '<div class="status-loading">📡 Building and broadcasting transaction...</div>';
    
    try {
        const data = await apiRequest('/api/send-from-funding', 'POST', {
            fundingData: currentFundingData,
            toAddress: toAddress,
            amount: 'all' // Send all
        });
        
        if (data.success) {
            // Stop balance checking
            if (fundingCheckInterval) {
                clearInterval(fundingCheckInterval);
                fundingCheckInterval = null;
            }
            
            resultDiv.innerHTML = `
                <div class="status-success deposit-success">
                    <div class="icon">✅</div>
                    <h3>Sent Successfully!</h3>
                    <p>Funds have been sent to your specified address.</p>
                    
                    <div class="deposit-details">
                        <div class="row">
                            <span class="label">Transaction ID</span>
                            <span class="value mono">${data.txid}</span>
                        </div>
                        <div class="row">
                            <span class="label">Amount Sent</span>
                            <span class="value">${(data.details.amount / 100000000).toFixed(8)} BSV</span>
                        </div>
                        <div class="row">
                            <span class="label">To Address</span>
                            <span class="value mono">${data.details.toAddress}</span>
                        </div>
                        <div class="row">
                            <span class="label">Network Fee</span>
                            <span class="value">${data.details.fee} sats</span>
                        </div>
                        <div class="row">
                            <span class="label">Broadcast Via</span>
                            <span class="value">${data.details.broadcastVia}</span>
                        </div>
                    </div>
                    
                    <a href="${data.explorerLink}" target="_blank" class="explorer-link">
                        🔗 View on WhatsOnChain
                    </a>
                    
                    <div style="margin-top: var(--spacing-xl);">
                        <button class="btn btn-secondary" onclick="resetFunding()">
                            <span class="btn-icon">➕</span>
                            <span>Start New Funding</span>
                        </button>
                    </div>
                </div>
            `;
            
            // Hide step 3 and send elsewhere since funds are gone
            document.getElementById('fundStep3').classList.add('hidden');
            document.getElementById('sendElsewhereSection').classList.add('hidden');
            document.getElementById('fundingBalanceContent').innerHTML = 
                '<div class="balance-zero">Funds sent - address empty</div>';
            
            showNotification('✅ Funds sent successfully!', 'success');
            
        } else {
            throw new Error(data.error);
        }
        
    } catch (error) {
        resultDiv.innerHTML = `<div class="status-error">❌ Send failed: ${error.message}</div>`;
        showNotification('❌ Send failed: ' + error.message, 'error');
    }
}

/**
 * Toggle password visibility for key fields
 */
function toggleKeyVisibility(inputId) {
    const input = document.getElementById(inputId);
    if (input.type === 'password') {
        input.type = 'text';
    } else {
        input.type = 'password';
    }
}

// Export new functions
window.showFundingSection = showFundingSection;
window.loadVaultForFunding = loadVaultForFunding;
window.generateFundingAddress = generateFundingAddress;
window.refreshFundingBalance = refreshFundingBalance;
window.depositToVault = depositToVault;
window.resetFunding = resetFunding;
window.sendElsewhere = sendElsewhere;
window.toggleKeyVisibility = toggleKeyVisibility;

/**
 * Quick fund from Access Vault section
 */
function quickFund() {
    const secret = document.getElementById('inputSecret').value.trim();
    
    if (!secret) {
        showNotification('Please enter the vault master secret first', 'warning');
        return;
    }
    
    // Validate secret format
    try {
        const decoded = atob(secret);
        JSON.parse(decoded);
    } catch (e) {
        showNotification('Invalid secret format', 'error');
        return;
    }
    
    // Show and populate funding section
    const fundSection = document.getElementById('fundSection');
    fundSection.style.display = 'block';
    
    // Copy secret to funding input
    document.getElementById('fundingSecretInput').value = secret;
    
    // Scroll to funding section
    fundSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    // Load vault for funding
    loadVaultForFunding();
}

window.quickFund = quickFund;
