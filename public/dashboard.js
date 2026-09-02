(() => {
  'use strict';

  const state = { csrfToken: '', currentPayment: null, refreshTimer: null };
  const currency = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
  const number = new Intl.NumberFormat('id-ID');
  const date = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'medium' });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const byId = id => document.getElementById(id);
  const escapeHTML = value => String(value ?? '—').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const formatDate = value => value ? date.format(new Date(value)) : '—';
  const formatDuration = seconds => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${number.format(hours)}j ${number.format(minutes)}m`;
  };

  async function api(url, options = {}) {
    const headers = { accept: 'application/json', ...(options.headers || {}) };
    if (state.csrfToken && options.method && options.method !== 'GET') headers['x-csrf-token'] = state.csrfToken;
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      window.location.assign('/admin/login');
      throw new Error('Sesi admin berakhir. Login kembali.');
    }
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `Request gagal dengan HTTP ${response.status}.`);
    return body;
  }

  function showError(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'alert');
    toast.textContent = message;
    byId('toast-region').appendChild(toast);
    window.setTimeout(() => toast.remove(), 6000);
  }

  function setButton(button, stateName, label) {
    button.dataset.state = stateName;
    button.disabled = stateName === 'loading';
    button.textContent = label;
  }

  function animateNumber(element, target, suffix = '') {
    const finalValue = Number(target) || 0;
    if (reducedMotion) {
      element.textContent = `${number.format(finalValue)}${suffix}`;
      return;
    }
    const started = performance.now();
    const duration = 400;
    const step = now => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = `${number.format(Math.round(finalValue * eased))}${suffix}`;
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function statusTone(status) {
    const value = String(status || '').toUpperCase();
    if (['PAID', 'ONLINE', 'VALID', 'DELIVERED', 'SUCCESS'].includes(value)) return 'success';
    if (['PENDING', 'RUNNING', 'NOT_SENT'].includes(value)) return 'warning';
    if (['EXPIRED', 'FAILED', 'INVALID', 'OFFLINE'].includes(value)) return 'error';
    return 'neutral';
  }

  function statusBadge(status) {
    const tone = statusTone(status);
    return `<span class="status-badge" data-tone="${tone}"><span class="status-dot" data-tone="${tone}"></span>${escapeHTML(status)}</span>`;
  }

  function renderRuntime(data) {
    const service = data.service;
    const merchant = data.merchant;
    const worker = data.worker;
    const tokenState = merchant.session_configured && !merchant.token_expired ? 'VALID' : 'INVALID';
    byId('service-dot').dataset.tone = service.status === 'ONLINE' ? 'success' : 'error';
    byId('service-state').textContent = `${service.status} · port ${service.port || '—'} · uptime ${formatDuration(service.uptime_seconds)}`;
    animateNumber(byId('metric-pending'), data.payments.pending);
    animateNumber(byId('metric-paid'), data.payments.paid);
    animateNumber(byId('metric-provider'), data.provider_transactions.length);
    animateNumber(byId('metric-memory'), service.memory_rss_mb, ' MB');

    byId('runtime-details').innerHTML = `
      <div><dt>Gateway</dt><dd>${statusBadge(service.status)}</dd></div>
      <div><dt>Port / Node</dt><dd>${escapeHTML(service.port)} / ${escapeHTML(service.node_version)}</dd></div>
      <div><dt>Merchant session</dt><dd>${statusBadge(tokenState)}</dd></div>
      <div><dt>Merchant ID</dt><dd>${escapeHTML(merchant.merchant_id)}</dd></div>
      <div><dt>Outlet</dt><dd>${escapeHTML(merchant.outlet_name)}</dd></div>
      <div><dt>Token expires</dt><dd>${escapeHTML(formatDate(merchant.token_expires_at))}</dd></div>
      <div><dt>Worker</dt><dd>${statusBadge(worker.running ? 'RUNNING' : (worker.last_error ? 'FAILED' : 'IDLE'))}</dd></div>
      <div><dt>Last sync</dt><dd>${escapeHTML(formatDate(worker.last_success_at))}</dd></div>
      <div><dt>Worker error</dt><dd>${escapeHTML(worker.last_error || 'Tidak ada')}</dd></div>`;
  }

  function renderProviderTransactions(transactions) {
    const target = byId('provider-table');
    if (!transactions.length) {
      target.innerHTML = '<tr><td colspan="4" class="empty-row">Belum ada transaksi provider dalam cache. Tekan Sync GoPay.</td></tr>';
      return;
    }
    target.innerHTML = transactions.map(tx => `
      <tr>
        <td data-label="Time">${escapeHTML(formatDate(tx.transaction_time))}</td>
        <td data-label="Transaction">${escapeHTML(tx.transaction_id)}</td>
        <td data-label="Issuer">${escapeHTML(tx.payer_issuer)}</td>
        <td data-label="Amount" class="numeric">${escapeHTML(currency.format(tx.amount || 0))}</td>
      </tr>`).join('');
  }

  function renderActivity(activity) {
    byId('activity-list').innerHTML = activity.length ? activity.map(item => `
      <li><span class="activity-time">${escapeHTML(formatDate(item.timestamp))}</span><span>${escapeHTML(item.type)} · ${escapeHTML(item.message)}</span></li>`).join('')
      : '<li><span class="activity-time">—</span><span>Belum ada activity pada proses ini.</span></li>';
  }

  function renderPayments(payments) {
    const target = byId('payments-table');
    if (!payments.length) {
      target.innerHTML = '<tr><td colspan="6" class="empty-row">Belum ada invoice. Buat payment test pertama.</td></tr>';
      return;
    }
    target.innerHTML = payments.map(payment => `
      <tr>
        <td data-label="Created">${escapeHTML(formatDate(payment.created_at))}</td>
        <td data-label="Order">${escapeHTML(payment.order_id)}</td>
        <td data-label="Status">${statusBadge(payment.status)}</td>
        <td data-label="Base" class="numeric">${escapeHTML(currency.format(payment.base_amount))}</td>
        <td data-label="Payable" class="numeric">${escapeHTML(currency.format(payment.amount))}</td>
        <td data-label="Match">${escapeHTML(payment.transaction_id || '—')}</td>
      </tr>`).join('');

    if (state.currentPayment) {
      const updated = payments.find(payment => payment.id === state.currentPayment.id);
      if (updated && updated.status !== state.currentPayment.status) renderPaymentResult(updated);
    }
  }

  function renderPaymentResult(payment) {
    state.currentPayment = payment;
    byId('payment-result').innerHTML = `
      <div class="qr-layout">
        <img src="${escapeHTML(payment.qr_image_url)}" width="420" height="420" alt="QRIS untuk order ${escapeHTML(payment.order_id)}">
        <div>
          ${statusBadge(payment.status)}
          <dl class="detail-list">
            <div><dt>Order</dt><dd>${escapeHTML(payment.order_id)}</dd></div>
            <div><dt>Payment ID</dt><dd>${escapeHTML(payment.id)}</dd></div>
            <div><dt>Reference</dt><dd>${escapeHTML(payment.merchant_reference)}</dd></div>
            <div><dt>Base</dt><dd>${escapeHTML(currency.format(payment.base_amount))}</dd></div>
            <div><dt>Unique</dt><dd>${escapeHTML(currency.format(payment.unique_code))}</dd></div>
            <div><dt>Payable</dt><dd>${escapeHTML(currency.format(payment.amount))}</dd></div>
            <div><dt>Expires</dt><dd>${escapeHTML(formatDate(payment.expires_at))}</dd></div>
          </dl>
        </div>
      </div>
      <div class="copy-row">
        <button class="button button--quiet" type="button" id="copy-payload-button">Copy payload</button>
        <button class="button button--quiet" type="button" id="refresh-payment-button">Refresh status</button>
      </div>`;

    byId('copy-payload-button').addEventListener('click', async event => {
      try {
        await navigator.clipboard.writeText(state.currentPayment.qris_code);
        setButton(event.currentTarget, 'success', 'Payload copied');
        window.setTimeout(() => setButton(event.currentTarget, 'default', 'Copy payload'), 2500);
      } catch {
        setButton(event.currentTarget, 'error', 'Copy failed');
      }
    });
    byId('refresh-payment-button').addEventListener('click', () => refreshCurrentPayment(true));
  }

  async function loadSession() {
    const response = await api('/admin/api/session');
    state.csrfToken = response.data.csrf_token;
    byId('admin-email').textContent = response.data.email;
  }

  async function loadMonitor(showFailure = false) {
    try {
      const response = await api('/admin/api/monitor');
      renderRuntime(response.data);
      renderProviderTransactions(response.data.provider_transactions || []);
      renderActivity(response.data.activity || []);
    } catch (error) {
      byId('service-dot').dataset.tone = 'error';
      byId('service-state').textContent = 'Backend tidak dapat dibaca';
      if (showFailure) showError(error.message);
    }
  }

  async function loadPayments(showFailure = false) {
    try {
      const response = await api('/admin/api/payments');
      renderPayments(response.data || []);
    } catch (error) {
      if (showFailure) showError(error.message);
    }
  }

  async function refreshCurrentPayment(showFailure = false) {
    if (!state.currentPayment) return;
    try {
      const response = await api(`/admin/api/payments/${encodeURIComponent(state.currentPayment.id)}`);
      renderPaymentResult(response.data);
    } catch (error) {
      if (showFailure) showError(error.message);
    }
  }

  byId('payment-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = byId('create-payment-button');
    const message = byId('payment-message');
    const form = new FormData(event.currentTarget);
    const orderId = String(form.get('order_id') || '').trim();
    const amount = Number(form.get('amount'));
    const callbackUrl = String(form.get('callback_url') || '').trim();

    const orderValid = /^[A-Za-z0-9._-]{1,100}$/.test(orderId);
    const amountValid = Number.isSafeInteger(amount) && amount > 0;
    byId('order-id').setAttribute('aria-invalid', orderValid ? 'false' : 'true');
    byId('amount').setAttribute('aria-invalid', amountValid ? 'false' : 'true');
    if (!orderValid || !amountValid) {
      message.textContent = 'Invoice belum dibuat. Perbaiki Order ID dan nominal, lalu coba lagi.';
      message.dataset.tone = 'error';
      return;
    }

    setButton(button, 'loading', 'Membuat…');
    message.textContent = '';
    delete message.dataset.tone;
    try {
      const response = await api('/admin/api/payments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order_id: orderId, amount, callback_url: callbackUrl || null })
      });
      renderPaymentResult(response.data);
      setButton(button, 'success', response.idempotent_replay ? 'Payment ditemukan' : 'Payment dibuat');
      message.textContent = response.idempotent_replay ? 'Order ID sudah ada; gateway mengembalikan invoice yang sama.' : 'Invoice tersimpan. QR siap dipindai.';
      message.dataset.tone = 'success';
      await Promise.all([loadPayments(), loadMonitor()]);
      window.setTimeout(() => setButton(button, 'default', 'Buat payment'), 2500);
    } catch (error) {
      setButton(button, 'error', 'Coba lagi');
      message.textContent = error.message;
      message.dataset.tone = 'error';
    }
  });

  byId('sync-button').addEventListener('click', async event => {
    const button = event.currentTarget;
    setButton(button, 'loading', 'Syncing…');
    try {
      const response = await api('/admin/api/monitor/sync', { method: 'POST' });
      renderProviderTransactions(response.data.transactions || []);
      setButton(button, 'success', 'Synced');
      await Promise.all([loadMonitor(), loadPayments(), refreshCurrentPayment()]);
      window.setTimeout(() => setButton(button, 'default', 'Sync GoPay'), 2500);
    } catch (error) {
      setButton(button, 'error', 'Sync failed');
      showError(error.message);
    }
  });

  byId('logout-button').addEventListener('click', async event => {
    setButton(event.currentTarget, 'loading', 'Logging out…');
    try {
      await api('/admin/api/logout', { method: 'POST' });
      window.location.assign('/admin/login');
    } catch (error) {
      setButton(event.currentTarget, 'error', 'Logout failed');
      showError(error.message);
    }
  });

  const sections = [...document.querySelectorAll('.workspace-section')];
  const navLinks = [...document.querySelectorAll('.section-nav a')];
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    for (const link of navLinks) link.setAttribute('aria-current', String(link.hash === `#${visible.target.id}`));
  }, { rootMargin: '-15% 0px -70% 0px', threshold: [0, 0.25, 0.5] });
  sections.forEach(section => observer.observe(section));

  async function init() {
    try {
      await loadSession();
      await Promise.all([loadMonitor(true), loadPayments(true)]);
      state.refreshTimer = window.setInterval(() => Promise.all([loadMonitor(), loadPayments(), refreshCurrentPayment()]), 10000);
    } catch (error) {
      showError(error.message);
    }
  }

  init();
})();
