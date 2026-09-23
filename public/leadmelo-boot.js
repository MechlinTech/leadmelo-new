(function () {
  if (document.querySelector('link[href="/leadmelo.css"]')) return;
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/leadmelo.css';
  (document.head || document.documentElement).appendChild(link);
})();
