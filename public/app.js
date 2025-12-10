/**
 * BSV Quantum Vault - Frontend Application
 * Handles UI interactions and API communication
 */

// =============================================================================
// API HELPER
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
    
    container.innerHTML = ''; // Clear previous
    
    if (!text || text === '...') return;
    
    try {
        new QRCode(container, {
            text: text,
            width: 150,
            height: 150,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
        });
    } catch (e) {
        console.error('QR generation error:', e);
    }
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Create a new Quantum Vault
 */
async function createVault() {
    const btn = document.getElementById('createBtn');
    const originalText = btn.innerHTML;
    
    btn.innerHTML = '<span class="btn-icon">⏳</span> Generating...';
    btn.disabled = true;

    try {
        const data = await apiRequest('/api/create');

        if (data.success) {
            // Show result section
            document.getElementById('result').style.display = 'block';
            
            // Populate vault address
            document.getElementById('vaultAddress').innerText = data.address;
            generateQR('qr_address', data.address);
            
            // Populate script details
            document.getElementById('lockingScriptASM').innerText = data.lockingScriptASM;
            document.getElementById('redeemScript').innerText = data.redeemScript;
            document.getElementById('scriptHash').innerText = data.scriptHash;
            document.getElementById('secretHash').innerText = data.secretHash;
            
            // Populate secret (CRITICAL)
            document.getElementById('vaultSecret').innerText = data.secret;
            
            // Scroll to result
            document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
            
            // Show success notification
            showNotification('✅ Quantum Vault Created!', 'success');
            
        } else {
            showNotification('❌ Error: ' + data.error, 'error');
        }

    } catch (error) {
        showNotification('❌ Error: ' + error.message, 'error');
    }

    btn.innerHTML = originalText;
    btn.disabled = false;
}

/**
 * Check vault balance
 */
async function checkBalance() {
    const secret = document.getElementById('sweepSecret').value.trim();
    const statusEl = document.getElementById('statusMsg');
    
    if (!secret) {
        showNotification('Please enter the vault secret first', 'warning');
        return;
    }
    
    if (secret.length !== 64) {
        statusEl.innerHTML = `
            <div class="status-error">
                ❌ Invalid secret format. Must be exactly 64 hex characters.
                <br><small>Current length: ${secret.length}</small>
            </div>
        `;
        return;
    }
    
    statusEl.innerHTML = '<div class="status-loading">🔄 Checking balance on BSV blockchain...</div>';

    try {
        const data = await apiRequest('/api/balance', 'POST', { secret });

        if (data.success) {
            statusEl.innerHTML = `
                <div class="status-success">
                    <div class="balance-display">
                        <span class="balance-amount">${data.bsv} BSV</span>
                        <span class="balance-sats">${data.balance.toLocaleString()} satoshis</span>
                    </div>
                    <div class="balance-usd">≈ $${data.usd} USD @ $${data.price}/BSV</div>
                    <div class="balance-address">
                        <small>Vault: ${data.address}</small>
                    </div>
                    ${data.unconfirmed > 0 ? `<div class="balance-pending">⏳ Pending: ${data.unconfirmed} sats</div>` : ''}
                </div>
            `;
        } else {
            statusEl.innerHTML = `<div class="status-error">❌ ${data.error}</div>`;
        }
    } catch (error) {
        statusEl.innerHTML = `<div class="status-error">❌ ${error.message}</div>`;
    }
}

/**
 * Sweep all funds from vault
 */
async function sweepVault() {
    const secret = document.getElementById('sweepSecret').value.trim();
    const toAddress = document.getElementById('recipientAddr').value.trim();
    const statusEl = document.getElementById('statusMsg');

    if (!secret) {
        showNotification('Please enter the vault secret', 'warning');
        return;
    }
    
    if (!toAddress) {
        showNotification('Please enter a destination address', 'warning');
        return;
    }

    if (secret.length !== 64) {
        statusEl.innerHTML = '<div class="status-error">❌ Invalid secret format (must be 64 hex characters)</div>';
        return;
    }

    // Validate address format
    if (!toAddress.startsWith('1') && !toAddress.startsWith('3')) {
        statusEl.innerHTML = '<div class="status-error">❌ Invalid BSV address. Must start with 1 or 3</div>';
        return;
    }

    // Confirm before sweeping
    const confirmed = confirm(
        '⚠️ CONFIRM SWEEP\n\n' +
        'This will send ALL funds from the vault to:\n' +
        toAddress + '\n\n' +
        'This action cannot be undone. Continue?'
    );
    
    if (!confirmed) return;

    statusEl.innerHTML = '<div class="status-loading">📡 Broadcasting transaction to BSV network...</div>';

    try {
        const data = await apiRequest('/api/sweep', 'POST', { secret, toAddress });

        if (data.success) {
            statusEl.innerHTML = `
                <div class="status-success sweep-success">
                    <div class="success-icon">✅</div>
                    <div class="success-title">Transaction Broadcast!</div>
                    <div class="tx-details">
                        <div class="detail-row">
                            <span>TXID:</span>
                            <span class="mono">${data.txid}</span>
                        </div>
                        <div class="detail-row">
                            <span>Amount:</span>
                            <span>${(data.details.amount / 100000000).toFixed(8)} BSV</span>
                        </div>
                        <div class="detail-row">
                            <span>Fee:</span>
                            <span>${data.details.fee} sats</span>
                        </div>
                    </div>
                    <a href="${data.explorerLink}" target="_blank" class="explorer-link">
                        🔗 View on WhatsOnChain
                    </a>
                </div>
            `;
            
            showNotification('🎉 Sweep successful!', 'success');
            
        } else {
            statusEl.innerHTML = `<div class="status-error">❌ ${data.error}</div>`;
        }
    } catch (error) {
        statusEl.innerHTML = `<div class="status-error">❌ ${error.message}</div>`;
    }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Copy text to clipboard
 */
function copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    const text = element.innerText;
    
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

/**
 * Toggle script details visibility
 */
function toggleDetails() {
    const details = document.getElementById('scriptDetails');
    const icon = document.querySelector('.toggle-icon');
    
    if (details.classList.contains('expanded')) {
        details.classList.remove('expanded');
        icon.textContent = '▼';
    } else {
        details.classList.add('expanded');
        icon.textContent = '▲';
    }
}

/**
 * Show notification toast
 */
function showNotification(message, type = 'info') {
    // Remove existing notifications
    const existing = document.querySelector('.notification');
    if (existing) existing.remove();
    
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = message;
    
    document.body.appendChild(notification);
    
    // Trigger animation
    setTimeout(() => notification.classList.add('show'), 10);
    
    // Auto-remove after 4 seconds
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

/**
 * Format satoshis to BSV
 */
function satsToBSV(sats) {
    return (sats / 100000000).toFixed(8);
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

// Handle Enter key in input fields
document.addEventListener('DOMContentLoaded', () => {
    const secretInput = document.getElementById('sweepSecret');
    const addressInput = document.getElementById('recipientAddr');
    
    if (secretInput) {
        secretInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                checkBalance();
            }
        });
        
        // Auto-format hex input
        secretInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
        });
    }
    
    if (addressInput) {
        addressInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sweepVault();
            }
        });
    }
});

// =============================================================================
// EXPOSE FUNCTIONS TO WINDOW (for onclick handlers)
// =============================================================================

window.createVault = createVault;
window.checkBalance = checkBalance;
window.sweepVault = sweepVault;
window.copyToClipboard = copyToClipboard;
window.toggleDetails = toggleDetails;
