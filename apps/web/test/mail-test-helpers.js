import { register } from 'node:module';

register('./jsx-loader.js', import.meta.url);

export class MockDomElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this._value = '';
    this.open = false;
  }
  get options() { return this.childNodes.filter((c) => c.tagName === 'OPTION'); }
  get length() { return this.tagName === 'SELECT' ? this.options.length : undefined; }
  get selectedIndex() { return 0; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get className() { return this.attributes.class || ''; }
  set className(v) { this.attributes.class = String(v); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(c) {
    this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const idx = this.childNodes.indexOf(c);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    c.parentNode = null;
    return c;
  }
  insertBefore(c, ref) {
    const idx = this.childNodes.indexOf(ref);
    if (idx >= 0) this.childNodes.splice(idx, 0, c);
    else this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }
  removeEventListener(type, fn) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
    }
  }
  dispatchEvent(event) {
    event.target = this;
    let curr = this;
    while (curr) {
      const handlers = curr.listeners[event.type] || [];
      for (const h of handlers) h.call(curr, event);
      curr = event.bubbles ? curr.parentNode : null;
    }
  }
  click() {
    this.dispatchEvent({ type: 'click', bubbles: true, target: this, button: 0, preventDefault() {}, stopPropagation() {} });
  }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  contains(node) {
    let curr = node;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(predicate) {
    const results = [];
    const walk = (el) => {
      if (typeof predicate === 'function') {
        if (predicate(el)) results.push(el);
      } else if (typeof predicate === 'string') {
        const p = predicate.trim();
        const pLower = p.toLowerCase();
        const attrMatch = p.match(/^([a-z0-9_-]+)?\[([a-z0-9_-]+)(?:=["']?([^"']*)["']?)?\]$/i);
        if (p.startsWith('.')) {
          const cls = p.slice(1);
          if (el.attributes?.class?.split(/\s+/).includes(cls)) results.push(el);
        } else if (p.startsWith('#')) {
          if (el.attributes?.id === p.slice(1)) results.push(el);
        } else if (attrMatch) {
          const [, expectedTag, attrName, expectedVal] = attrMatch;
          const tagMatches = !expectedTag || el.tagName?.toLowerCase() === expectedTag.toLowerCase();
          const attrVal = el.attributes?.[attrName] ?? el[attrName];
          if (tagMatches && (expectedVal !== undefined ? String(attrVal) === expectedVal : attrVal !== undefined)) {
            results.push(el);
          }
        } else if (el.tagName?.toLowerCase() === pLower) {
          results.push(el);
        }
      }
      for (const child of el.childNodes || []) {
        if (child.nodeType === 1) walk(child);
      }
    };
    walk(this);
    return results;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent ?? c.nodeValue ?? '').join('');
  }
  set textContent(v) {
    this.childNodes = v ? [this.ownerDocument.createTextNode(v)] : [];
  }
}

export class MockTextNode {
  constructor(t, doc) {
    this.nodeType = 3;
    this._value = String(t ?? '');
    this.ownerDocument = doc;
  }
  get nodeValue() { return this._value; }
  set nodeValue(v) { this._value = String(v ?? ''); }
  get textContent() { return this._value; }
  set textContent(v) { this._value = String(v ?? ''); }
  get data() { return this._value; }
  set data(v) { this._value = String(v ?? ''); }
}

export function setupMockDom() {
  const doc = {
    nodeType: 9,
    createElement(t) {
      const el = new MockDomElement(t);
      el.ownerDocument = doc;
      return el;
    },
    createElementNS(ns, tag) { return doc.createElement(tag); },
    createTextNode(t) { return new MockTextNode(t, doc); },
    addEventListener(type, fn) {
      if (!this.listeners) this.listeners = {};
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (this.listeners && this.listeners[type]) {
        this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
      }
    },
    activeElement: null,
  };
  const win = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
    HTMLIFrameElement: class {},
    dispatchEvent() {},
  };
  doc.defaultView = win;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.HTMLIFrameElement = win.HTMLIFrameElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { doc, win };
}

export function getProps(el) {
  if (!el) return {};
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  return key ? el[key] : {};
}

export function clickElement(el) {
  if (!el) throw new Error('Cannot click undefined element');
  const props = getProps(el);
  if (props.disabled || el.attributes?.disabled !== undefined || el.disabled) {
    return;
  }
  if (typeof props.onClick === 'function') {
    props.onClick({ preventDefault() {}, stopPropagation() {}, button: 0 });
  } else {
    el.click();
  }
  const isSubmit = props.type === 'submit' || el.type === 'submit' || el.attributes?.type === 'submit';
  if (isSubmit) {
    let form = el.parentNode;
    while (form && form.tagName !== 'FORM') {
      form = form.parentNode;
    }
    if (form) {
      submitForm(form);
    }
  }
}

export function changeInput(el, value) {
  if (!el) throw new Error('Cannot change undefined element');
  el.value = value;
  const props = getProps(el);
  if (typeof props.onChange === 'function') {
    props.onChange({ target: { value, checked: Boolean(value) }, preventDefault() {}, stopPropagation() {} });
  } else {
    el.dispatchEvent({ type: 'change', bubbles: true, target: el });
  }
}

export function submitForm(el) {
  if (!el) throw new Error('Cannot submit undefined element');
  const props = getProps(el);
  if (typeof props.onSubmit === 'function') {
    props.onSubmit({ preventDefault() {}, stopPropagation() {} });
  } else {
    el.dispatchEvent({ type: 'submit', bubbles: true, target: el });
  }
}

export async function flush(act, count = 6, ms = 30) {
  for (let i = 0; i < count; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  }
}
