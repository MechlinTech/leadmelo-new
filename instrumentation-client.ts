const href = '/leadmelo.css';
if (typeof document !== 'undefined' && !document.querySelector(`link[href="${href}"]`)) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  (document.head || document.documentElement).appendChild(link);
}
