export function debounce(callback, delay = 120, timers = globalThis) {
  let timeoutID = null;

  function debounced(...args) {
    if (timeoutID != null) timers.clearTimeout(timeoutID);
    timeoutID = timers.setTimeout(() => {
      timeoutID = null;
      callback(...args);
    }, delay);
  }

  debounced.cancel = () => {
    if (timeoutID != null) timers.clearTimeout(timeoutID);
    timeoutID = null;
  };

  return debounced;
}

export function yieldToBrowser() {
  return new Promise(resolve => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
    } else {
      globalThis.setTimeout(resolve, 0);
    }
  });
}
