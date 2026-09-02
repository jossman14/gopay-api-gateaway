(() => {
  'use strict';

  const form = document.getElementById('login-form');
  const email = document.getElementById('email');
  const password = document.getElementById('password');
  const button = document.getElementById('login-button');
  const message = document.getElementById('login-message');
  const touched = new Set();

  function setFieldState(input, helpId, error) {
    const field = input.closest('.field');
    const helper = document.getElementById(helpId);
    input.setAttribute('aria-invalid', error ? 'true' : 'false');
    field.dataset.state = error ? 'error' : input.value ? 'success' : 'default';
    if (error) {
      helper.textContent = error;
      helper.dataset.tone = 'error';
    } else {
      helper.textContent = input === email ? 'Format: nama@domain.com' : 'Password tidak pernah dikirim ke frontend kembali.';
      delete helper.dataset.tone;
    }
  }

  function validate(input) {
    if (input === email) {
      const error = !input.value ? 'Email belum diisi. Masukkan alamat email admin.' : (!input.validity.valid ? 'Format email tidak valid. Gunakan nama@domain.com.' : '');
      setFieldState(input, 'email-help', error);
      return !error;
    }
    const error = !input.value ? 'Password belum diisi. Masukkan password admin.' : '';
    setFieldState(input, 'password-help', error);
    return !error;
  }

  for (const input of [email, password]) {
    input.addEventListener('blur', () => { touched.add(input); validate(input); });
    input.addEventListener('input', () => { if (touched.has(input)) validate(input); });
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    touched.add(email); touched.add(password);
    if (![email, password].every(validate)) return;

    button.disabled = true;
    button.dataset.state = 'loading';
    button.textContent = 'Memeriksa…';
    message.textContent = '';
    delete message.dataset.tone;

    try {
      const response = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.value.trim(), password: password.value })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Login ditolak oleh server. Periksa kredensial dan coba lagi.');
      button.dataset.state = 'success';
      button.textContent = 'Login diterima';
      message.textContent = 'Sesi admin aktif. Membuka dashboard…';
      message.dataset.tone = 'success';
      window.location.assign('/admin');
    } catch (error) {
      button.disabled = false;
      button.dataset.state = 'error';
      button.textContent = 'Coba login lagi';
      message.textContent = error.message;
      message.dataset.tone = 'error';
    }
  });
})();
