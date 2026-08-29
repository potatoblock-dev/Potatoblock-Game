(function (global) {
  'use strict';

  /** 右下图层列表面板（Krita 式）。 */
  class LayerPanel {
    constructor(root, options) {
      const settings = options || {};
      this.root = root;
      this.listEl = root && root.querySelector('[data-layer-list]');
      this.onSwitch = settings.onSwitch || (() => {});
      this.onCreate = settings.onCreate || (() => {});
      this.onDelete = settings.onDelete || (() => {});
      this.onRename = settings.onRename || (() => {});
      this.onReorder = settings.onReorder || (() => {});
      this.onUpdate = settings.onUpdate || (() => {});
      this.activeLayerId = '';
      this.layers = [];
      const addBtn = root && root.querySelector('[data-layer-add]');
      const delBtn = root && root.querySelector('[data-layer-delete]');
      const upBtn = root && root.querySelector('[data-layer-up]');
      const downBtn = root && root.querySelector('[data-layer-down]');
      if (addBtn) addBtn.addEventListener('click', () => this.onCreate());
      if (delBtn) delBtn.addEventListener('click', () => this.onDelete(this.activeLayerId));
      if (upBtn) upBtn.addEventListener('click', () => this._moveActive(-1));
      if (downBtn) downBtn.addEventListener('click', () => this._moveActive(1));
    }

    setLayers(layers, activeLayerId) {
      this.layers = (layers || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      this.activeLayerId = activeLayerId || '';
      this._render();
    }

    setActive(layerId) {
      this.activeLayerId = layerId;
      if (!this.listEl) return;
      this.listEl.querySelectorAll('[data-layer-id]').forEach(row => {
        row.classList.toggle('is-active', row.dataset.layerId === layerId);
      });
    }

    _moveActive(delta) {
      const order = this.layers.map(l => l.layer_id);
      const idx = order.indexOf(this.activeLayerId);
      if (idx < 0) return;
      const next = idx + delta;
      if (next < 0 || next >= order.length) return;
      order.splice(idx, 1);
      order.splice(next, 0, this.activeLayerId);
      this.onReorder(order);
    }

    _render() {
      if (!this.listEl) return;
      this.listEl.innerHTML = '';
      this.layers.slice().reverse().forEach(layer => {
        const row = document.createElement('div');
        row.className = 'layer-row' + (layer.layer_id === this.activeLayerId ? ' is-active' : '');
        row.dataset.layerId = layer.layer_id;
        const visBtn = document.createElement('button');
        visBtn.type = 'button';
        visBtn.className = 'layer-icon-btn';
        visBtn.setAttribute('data-tooltip', '可见性');
        visBtn.setAttribute('aria-label', '可见性');
        visBtn.appendChild(MaterialIcons.createIcon(
          layer.visible !== false ? 'visibility' : 'visibility_off',
          'layer-action-icon'
        ));
        visBtn.addEventListener('click', event => {
          event.stopPropagation();
          this.onUpdate(layer.layer_id, { visible: layer.visible === false });
        });
        const lockBtn = document.createElement('button');
        lockBtn.type = 'button';
        lockBtn.className = 'layer-icon-btn';
        lockBtn.setAttribute('data-tooltip', '锁定');
        lockBtn.setAttribute('aria-label', '锁定');
        lockBtn.appendChild(MaterialIcons.createIcon(
          layer.locked ? 'lock' : 'lock_open',
          'layer-action-icon'
        ));
        lockBtn.addEventListener('click', event => {
          event.stopPropagation();
          this.onUpdate(layer.layer_id, { locked: !layer.locked });
        });
        const name = document.createElement('span');
        name.className = 'layer-row-name';
        name.textContent = layer.name || layer.layer_id;
        name.addEventListener('dblclick', event => {
          event.stopPropagation();
          const next = prompt('重命名图层', layer.name || '');
          if (next != null && next.trim()) this.onRename(layer.layer_id, next.trim());
        });
        const opacity = document.createElement('input');
        opacity.type = 'range';
        opacity.className = 'layer-row-opacity';
        opacity.min = '0';
        opacity.max = '255';
        opacity.value = String(layer.opacity != null ? layer.opacity : 255);
        opacity.addEventListener('input', event => {
          event.stopPropagation();
          this.onUpdate(layer.layer_id, { opacity: Number(opacity.value) });
        });
        opacity.addEventListener('click', event => event.stopPropagation());
        row.appendChild(visBtn);
        row.appendChild(lockBtn);
        row.appendChild(name);
        row.appendChild(opacity);
        row.addEventListener('click', () => this.onSwitch(layer.layer_id));
        this.listEl.appendChild(row);
      });
    }
  }

  global.LayerPanel = LayerPanel;
})(window);
