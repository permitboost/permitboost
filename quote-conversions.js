/* Quote tracking: keep raw contact details out of browser storage and URLs. */
(function(){
  'use strict';

  var storageKey = 'permitboost.quoteConversion';
  var maxAge = 30 * 60 * 1000;

  function clearPending(){
    try { window.sessionStorage.removeItem(storageKey); } catch (err) {}
  }

  function hash(value){
    return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
      .then(function(buffer){
        return Array.from(new Uint8Array(buffer)).map(function(byte){
          return byte.toString(16).padStart(2, '0');
        }).join('');
      });
  }

  function userData(formData){
    var email = String(formData.get('email') || '').trim().toLowerCase();
    var phone = String(formData.get('phone') || '').replace(/\D/g, '');
    // Google's normalization rules remove dots from Gmail local parts.
    var parts = email.split('@');
    if(parts.length === 2 && /^(gmail|googlemail)\.com$/.test(parts[1])){
      email = parts[0].replace(/\./g, '') + '@' + parts[1];
    }
    // The quote form accepts US ten-digit numbers; Ads requires E.164.
    if(phone.length === 10) phone = '1' + phone;
    phone = /^1\d{10}$/.test(phone) ? '+' + phone : '';

    // If hashing is unavailable, retain ordinary conversion tracking without PII.
    if(!window.crypto || !window.crypto.subtle || typeof TextEncoder === 'undefined') return Promise.resolve({});
    return Promise.all([email ? hash(email) : '', phone ? hash(phone) : ''])
      .then(function(hashes){
        var data = {};
        if(hashes[0]) data.sha256_email_address = hashes[0];
        if(hashes[1]) data.sha256_phone_number = hashes[1];
        return data;
      }).catch(function(){ return {}; });
  }

  function track(record){
    return new Promise(function(resolve){
      var timer;
      function done(){ window.clearTimeout(timer); resolve(); }
      // Allow the tag time to send before a fallback redirect; never block the form.
      timer = window.setTimeout(done, 1500);
      try {
        window.gtag('set', 'user_data', record.user_data);
        window.gtag('event', 'conversion', {
          'send_to': 'AW-18201677678/lDv9CPaPzPIcEO6enudD',
          'value': 175.0,
          'currency': 'USD',
          'transaction_id': record.submission_id,
          'event_callback': done,
          'event_timeout': 1500
        });
      } catch (err) { done(); }
    });
  }

  function recordSuccess(formData){
    // Call only after Formspree's successful response, using the submitted snapshot.
    return userData(formData).then(function(data){
      var record = {
        version: 1,
        submission_id: window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
        submitted_at: Date.now(),
        user_data: data
      };
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(record));
        return;
      } catch (err) {
        // Storage blocked/full: track this confirmed submission here instead.
        return track(record);
      }
    });
  }

  function consumePending(){
    var stored;
    try {
      stored = window.sessionStorage.getItem(storageKey);
      // Remove before queuing the event so refresh/back cannot record it again.
      window.sessionStorage.removeItem(storageKey);
    } catch (err) { return; }
    if(!stored) return;

    try {
      var record = JSON.parse(stored);
      var age = Date.now() - record.submitted_at;
      if(record.version !== 1 || typeof record.submission_id !== 'string' ||
         !/^[a-z0-9-]{16,80}$/i.test(record.submission_id) ||
         typeof record.submitted_at !== 'number' || !Number.isFinite(age) ||
         age < 0 || age > maxAge || !record.user_data) return;

      // Forward only verified hash fields, never raw or unexpected stored data.
      var data = {};
      ['sha256_email_address', 'sha256_phone_number'].forEach(function(key){
        if(typeof record.user_data[key] === 'string' && /^[a-f0-9]{64}$/.test(record.user_data[key])){
          data[key] = record.user_data[key];
        }
      });
      record.user_data = data;
      return track(record);
    } catch (err) {}
  }

  window.PermitBoostConversions = {
    clearPending: clearPending,
    recordSuccess: recordSuccess,
    consumePending: consumePending
  };
})();
