(function () {
  var match = document.cookie.match(/(?:^|; )lm_theme=([^;]*)/);
  var theme = match ? decodeURIComponent(match[1]) : '';
  if (theme === 'system' || theme === 'light' || theme === 'dark' || theme === 'ocean' || theme === 'forest' || theme === 'sunset') {
    document.documentElement.setAttribute('data-theme', theme);
  }
  if (document.querySelector('link[href="/leadmelo.css"]')) return;
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/leadmelo.css';
  (document.head || document.documentElement).appendChild(link);
})();
