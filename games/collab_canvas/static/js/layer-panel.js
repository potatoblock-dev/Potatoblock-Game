(function (global) {
  'use strict';

  /** 右下图层列表面板（Krita 式底栏 + 属性 popover + 右键菜单）。 */
  class LayerPanel {
    constructor(root, options) {
      const settings = options || {};
      this.root = root;
      this.listEl = root && root.querySelector('[data-layer-list]');
      this.onSwitch = settings.onSwitch || (() => {});
      this.onCreate = settings.onCreate || (() => {});
      this.onCreateGroup = settings.onCreateGroup || (() => {});
      this.onDuplicate = settings.onDuplicate || (() => {});
      this.onDelete = settings.onDelete || (() => {});
      this.onRename = settings.onRename || (() => {});
      this.onReorder = settings.onReorder || (() => {});
      this.onUpdate = settings.onUpdate || (() => {});
      this.getBoardState = settings.getBoardState || (() => null);
      this.activeLayerId = '';
      this.layers = [];
      this._openPopup = null;
      this._openPopupAnchor = null;
      this._propsOpacityInput = null;
      this._propsOpacityOut = null;
      this._renamingLayerId = null;
      this._renameBlurTimer = null;
      this._collapsedGroups = LayerPanel._loadCollapsedGroups();
      this._onDocPointer = this._onDocPointer.bind(this);
      this._onDocKey = this._onDocKey.bind(this);
      document.addEventListener('pointerdown', this._onDocPointer, true);
      document.addEventListener('keydown', this._onDocKey, true);
      this._bindFooter();
    }

    /** 绑定 Krita 式底栏按钮。 */
    _bindFooter() {
      if (!this.root) return;
      const addMain = this.root.querySelector('[data-layer-add-main]');
      const addMenu = this.root.querySelector('[data-layer-add-menu]');
      const dupBtn = this.root.querySelector('[data-layer-duplicate]');
      const upBtn = this.root.querySelector('[data-layer-up]');
      const downBtn = this.root.querySelector('[data-layer-down]');
      const propsMain = this.root.querySelector('[data-layer-props-main]');
      const propsMenu = this.root.querySelector('[data-layer-props-menu]');
      const groupBtn = this.root.querySelector('[data-layer-group]');
      if (addMain) addMain.addEventListener('click', () => this.onCreate());
      if (groupBtn) groupBtn.addEventListener('click', () => this.onCreateGroup());
      if (dupBtn) {
        dupBtn.addEventListener('click', () => {
          const active = this.layers.find(l => l.layer_id === this.activeLayerId);
          if (active && this._isGroupLayer(active)) return;
          this.onDuplicate(this.activeLayerId);
        });
      }
      if (addMenu) {
        addMenu.addEventListener('click', event => {
          event.stopPropagation();
          this._toggleAddMenu(addMenu);
        });
      }
      if (upBtn) upBtn.addEventListener('click', () => this._moveActive(-1));
      if (downBtn) downBtn.addEventListener('click', () => this._moveActive(1));
      if (propsMain) {
        propsMain.addEventListener('click', event => {
          event.stopPropagation();
          this._togglePropsPopover(propsMain);
        });
      }
      if (propsMenu) {
        propsMenu.addEventListener('click', event => {
          event.stopPropagation();
          this._togglePropsPopover(propsMenu);
        });
      }
    }

    setLayers(layers, activeLayerId) {
      this.layers = (layers || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      this.activeLayerId = activeLayerId || '';
      this._render();
      if (this._openPopup && this._openPopup.classList.contains('layer-props-popover')) {
        this._syncPropsPopover();
      }
    }

    setActive(layerId) {
      this.activeLayerId = layerId;
      if (!this.listEl) return;
      this.listEl.querySelectorAll('.layer-row').forEach(row => {
        const active = row.dataset.layerId === layerId;
        row.classList.toggle('is-active', active);
        const check = row.querySelector('.layer-row-check');
        if (check) {
          check.classList.toggle('is-checked', active);
          check.textContent = '';
          if (active) {
            check.appendChild(MaterialIcons.createIcon('check', 'layer-row-check-icon'));
          }
        }
      });
      if (this._openPopup && this._openPopup.classList.contains('layer-props-popover')) {
        this._syncPropsPopover();
      }
    }

    /** 读取本地折叠的图层组 id 集合。 */
    static _loadCollapsedGroups() {
      try {
        const raw = localStorage.getItem('collab-layer-collapsed-v1');
        const list = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(list) ? list : []);
      } catch (_err) {
        return new Set();
      }
    }

    /** 持久化折叠的图层组 id。 */
    _saveCollapsedGroups() {
      try {
        localStorage.setItem(
          'collab-layer-collapsed-v1',
          JSON.stringify(Array.from(this._collapsedGroups))
        );
      } catch (_err) {}
    }

    _isGroupLayer(layer) {
      return Boolean(layer && layer.kind === 'group');
    }

    /** 构建树形扁平列表（UI 顶→底，含缩进深度）。 */
    _buildDisplayList() {
      const idSet = new Set(this.layers.map(layer => layer.layer_id));
      const normalized = this.layers.map(layer => {
        const pid = layer.parent_id || '';
        if (pid && !idSet.has(pid)) {
          return Object.assign({}, layer, { parent_id: '' });
        }
        return layer;
      });
      const byParent = new Map();
      normalized.forEach(layer => {
        const pid = layer.parent_id || '';
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(layer);
      });
      const sortByOrder = items => items.sort((a, b) => (a.order || 0) - (b.order || 0));
      const out = [];
      const walk = (parentId, depth) => {
        sortByOrder(byParent.get(parentId) || []).forEach(layer => {
          out.push({ layer, depth });
          if (this._isGroupLayer(layer) && !this._collapsedGroups.has(layer.layer_id)) {
            walk(layer.layer_id, depth + 1);
          }
        });
      };
      walk('', 0);
      if (out.length === 0 && this.layers.length > 0) {
        return normalized
          .slice()
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .map(layer => ({ layer, depth: 0 }))
          .reverse();
      }
      return out.reverse();
    }

    _flatLayerIdsTopFirst() {
      return this._buildDisplayList().map(entry => entry.layer.layer_id);
    }

    _toggleGroupCollapsed(layerId) {
      if (this._collapsedGroups.has(layerId)) this._collapsedGroups.delete(layerId);
      else this._collapsedGroups.add(layerId);
      this._saveCollapsedGroups();
      this._render();
    }

    _moveActive(delta) {
      const flat = this._flatLayerIdsTopFirst();
      const idx = flat.indexOf(this.activeLayerId);
      if (idx < 0) return;
      const next = idx + delta;
      if (next < 0 || next >= flat.length) return;
      flat.splice(idx, 1);
      flat.splice(next, 0, this.activeLayerId);
      this.onReorder(flat.slice().reverse());
    }

    _activeLayer() {
      return this.layers.find(l => l.layer_id === this.activeLayerId) || null;
    }

    _closePopup() {
      if (this._openPopup && this._openPopup.parentNode) {
        this._openPopup.parentNode.removeChild(this._openPopup);
      }
      if (this._openPopupAnchor) {
        this._openPopupAnchor.classList.remove('is-open');
        this._openPopupAnchor.setAttribute('aria-expanded', 'false');
      }
      this._openPopup = null;
      this._openPopupAnchor = null;
      this._propsOpacityInput = null;
      this._propsOpacityOut = null;
    }

    /** 将 popover 固定定位到锚点上方。 */
    _positionPopup(anchorEl, popupEl, prefer) {
      if (!anchorEl || !popupEl) return;
      const rect = anchorEl.getBoundingClientRect();
      popupEl.style.position = 'fixed';
      popupEl.style.zIndex = '2100';
      const popupRect = popupEl.getBoundingClientRect();
      let top = rect.top - popupRect.height - 4;
      if (prefer !== 'above' || top < 4) {
        top = rect.bottom + 4;
      }
      if (top + popupRect.height > window.innerHeight - 4) {
        top = Math.max(4, rect.top - popupRect.height - 4);
      }
      let left = rect.left;
      if (left + popupRect.width > window.innerWidth - 4) {
        left = window.innerWidth - popupRect.width - 4;
      }
      popupEl.style.left = Math.round(left) + 'px';
      popupEl.style.top = Math.round(top) + 'px';
    }

    _openAnchoredPopup(anchorEl, popupEl, options) {
      const settings = options || {};
      if (this._openPopup === popupEl && this._openPopupAnchor === anchorEl) {
        this._closePopup();
        return;
      }
      this._closePopup();
      document.body.appendChild(popupEl);
      this._openPopup = popupEl;
      this._openPopupAnchor = anchorEl;
      anchorEl.classList.add('is-open');
      anchorEl.setAttribute('aria-expanded', 'true');
      this._positionPopup(anchorEl, popupEl, settings.prefer);
    }

    _toggleAddMenu(anchorEl) {
      const menu = document.createElement('div');
      menu.className = 'layer-footer-menu';
      menu.setAttribute('role', 'menu');
      const layerItem = document.createElement('button');
      layerItem.type = 'button';
      layerItem.className = 'layer-footer-menu-item';
      layerItem.textContent = '新建图层';
      layerItem.setAttribute('role', 'menuitem');
      layerItem.addEventListener('click', event => {
        event.stopPropagation();
        this._closePopup();
        this.onCreate();
      });
      const groupItem = document.createElement('button');
      groupItem.type = 'button';
      groupItem.className = 'layer-footer-menu-item';
      groupItem.textContent = '新建图层组';
      groupItem.setAttribute('role', 'menuitem');
      groupItem.addEventListener('click', event => {
        event.stopPropagation();
        this._closePopup();
        this.onCreateGroup();
      });
      const maskItem = document.createElement('button');
      maskItem.type = 'button';
      maskItem.className = 'layer-footer-menu-item';
      maskItem.textContent = '新建蒙版';
      maskItem.setAttribute('role', 'menuitem');
      maskItem.disabled = true;
      maskItem.title = '即将推出';
      menu.appendChild(layerItem);
      menu.appendChild(groupItem);
      menu.appendChild(maskItem);
      this._openAnchoredPopup(anchorEl, menu, { prefer: 'above' });
    }

    _buildPropsPopover() {
      const popover = document.createElement('div');
      popover.className = 'layer-props-popover';
      popover.setAttribute('role', 'dialog');
      popover.setAttribute('aria-label', '图层属性');
      const head = document.createElement('div');
      head.className = 'layer-props-head';
      head.textContent = '图层属性';
      const row = document.createElement('div');
      row.className = 'layer-props-row';
      const label = document.createElement('label');
      label.textContent = '不透明度';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '255';
      slider.value = '255';
      const out = document.createElement('output');
      out.textContent = '100%';
      slider.addEventListener('input', () => {
        const value = Number(slider.value);
        out.textContent = Math.round(value / 255 * 100) + '%';
        if (this.activeLayerId) this.onUpdate(this.activeLayerId, { opacity: value });
      });
      slider.addEventListener('pointerdown', event => event.stopPropagation());
      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(out);
      const maskBlock = document.createElement('div');
      maskBlock.className = 'layer-props-mask-placeholder';
      maskBlock.innerHTML = '<h4>蒙版</h4><p>即将推出</p>';
      popover.appendChild(head);
      popover.appendChild(row);
      popover.appendChild(maskBlock);
      this._propsOpacityInput = slider;
      this._propsOpacityOut = out;
      return popover;
    }

    _syncPropsPopover() {
      if (!this._propsOpacityInput || !this._propsOpacityOut) return;
      const layer = this._activeLayer();
      const opacity = layer && layer.opacity != null ? layer.opacity : 255;
      this._propsOpacityInput.value = String(opacity);
      this._propsOpacityOut.textContent = Math.round(opacity / 255 * 100) + '%';
    }

    _togglePropsPopover(anchorEl) {
      const existing = this._openPopup;
      if (existing && existing.classList.contains('layer-props-popover')) {
        this._closePopup();
        return;
      }
      const popover = this._buildPropsPopover();
      this._syncPropsPopover();
      this._openAnchoredPopup(anchorEl, popover, { prefer: 'above' });
    }

    /** 在光标处显示图层右键菜单。 */
    _showContextMenu(layer, clientX, clientY) {
      this._closePopup();
      const menu = document.createElement('div');
      menu.className = 'layer-context-menu';
      menu.setAttribute('role', 'menu');
      const delItem = document.createElement('button');
      delItem.type = 'button';
      delItem.className = 'layer-context-menu-item is-danger';
      delItem.textContent = this._isGroupLayer(layer) ? '删除图层组' : '删除图层';
      delItem.setAttribute('role', 'menuitem');
      delItem.addEventListener('click', event => {
        event.stopPropagation();
        this._closePopup();
        if (confirm('删除「' + (layer.name || layer.layer_id) + '」？')) {
          this.onDelete(layer.layer_id);
        }
      });
      const renameItem = document.createElement('button');
      renameItem.type = 'button';
      renameItem.className = 'layer-context-menu-item';
      renameItem.textContent = '重命名图层';
      renameItem.setAttribute('role', 'menuitem');
      renameItem.addEventListener('click', event => {
        event.stopPropagation();
        this._closePopup();
        this.onSwitch(layer.layer_id);
        this.startRename(layer.layer_id);
      });
      menu.appendChild(renameItem);
      menu.appendChild(delItem);
      document.body.appendChild(menu);
      this._openPopup = menu;
      menu.style.position = 'fixed';
      menu.style.left = Math.round(clientX) + 'px';
      menu.style.top = Math.round(clientY) + 'px';
      menu.style.zIndex = '2100';
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth - 4) {
        menu.style.left = Math.round(window.innerWidth - rect.width - 4) + 'px';
      }
      if (rect.bottom > window.innerHeight - 4) {
        menu.style.top = Math.round(window.innerHeight - rect.height - 4) + 'px';
      }
    }

    _onDocPointer(event) {
      if (!this._openPopup) return;
      if (this._openPopup.contains(event.target)) return;
      const split = this.root && (
        this.root.querySelector('[data-layer-add-split]')?.contains(event.target)
        || this.root.querySelector('[data-layer-props-split]')?.contains(event.target)
      );
      if (split) return;
      this._closePopup();
    }

    _onDocKey(event) {
      if (event.key !== 'Escape') return;
      if (this._renamingLayerId) {
        this._cancelRename();
        return;
      }
      this._closePopup();
    }

    /** 刷新各行缩略图（绘制变更后由 board 调用）。 */
    refreshThumbnails() {
      const state = this.getBoardState();
      if (!state || !this.listEl || !global.LayerThumbnail) return;
      this.listEl.querySelectorAll('.layer-row').forEach(row => {
        const layerId = row.dataset.layerId;
        const layer = this.layers.find(item => item.layer_id === layerId);
        if (!layer || this._isGroupLayer(layer)) return;
        const canvas = row.querySelector('.layer-row-thumb-canvas');
        if (canvas && layer) {
          LayerThumbnail.paint(canvas, state.drawingBoard, state.strokes, layer);
        }
      });
    }

    /** 绑定图层名称双击进入行内重命名。 */
    _bindNameLabel(nameEl, layer) {
      nameEl.addEventListener('dblclick', event => {
        event.stopPropagation();
        this.startRename(layer.layer_id);
      });
    }

    /** 取消进行中的行内重命名（不提交）。 */
    _cancelRename() {
      if (this._renameBlurTimer) {
        window.clearTimeout(this._renameBlurTimer);
        this._renameBlurTimer = null;
      }
      if (!this._renamingLayerId || !this.listEl) {
        this._renamingLayerId = null;
        return;
      }
      const row = this.listEl.querySelector('.layer-row[data-layer-id="' + this._renamingLayerId + '"]');
      const input = row && row.querySelector('.layer-row-name-input');
      if (!input) {
        this._renamingLayerId = null;
        return;
      }
      const layer = this.layers.find(item => item.layer_id === this._renamingLayerId);
      const span = document.createElement('span');
      span.className = 'layer-row-name';
      span.textContent = (layer && layer.name) || this._renamingLayerId;
      if (layer) this._bindNameLabel(span, layer);
      input.replaceWith(span);
      if (row) row.classList.remove('is-renaming');
      this._renamingLayerId = null;
    }

    /** 行内重命名（Krita 式：名称区变为输入框并全选）。 */
    startRename(layerId) {
      if (!this.listEl || !layerId) return;
      if (this._renamingLayerId === layerId) return;
      this._cancelRename();
      const layer = this.layers.find(item => item.layer_id === layerId);
      if (!layer) return;
      const row = this.listEl.querySelector('.layer-row[data-layer-id="' + layerId + '"]');
      if (!row) return;
      const nameEl = row.querySelector('.layer-row-name');
      if (!nameEl) return;

      const originalName = layer.name || layerId;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'layer-row-name-input';
      input.value = originalName;
      input.maxLength = 40;
      input.setAttribute('aria-label', '图层名称');

      const finish = commit => {
        if (this._renameBlurTimer) {
          window.clearTimeout(this._renameBlurTimer);
          this._renameBlurTimer = null;
        }
        if (this._renamingLayerId !== layerId) return;
        const next = input.value.trim();
        if (commit && next && next !== originalName) {
          this.onRename(layerId, next);
        }
        const span = document.createElement('span');
        span.className = 'layer-row-name';
        span.textContent = commit && next ? next : originalName;
        this._bindNameLabel(span, layer);
        if (input.parentNode) input.replaceWith(span);
        row.classList.remove('is-renaming');
        this._renamingLayerId = null;
      };

      input.addEventListener('pointerdown', event => event.stopPropagation());
      input.addEventListener('click', event => event.stopPropagation());
      input.addEventListener('dblclick', event => event.stopPropagation());
      input.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', () => {
        this._renameBlurTimer = window.setTimeout(() => finish(true), 0);
      });

      nameEl.replaceWith(input);
      row.classList.add('is-renaming');
      this._renamingLayerId = layerId;
      input.focus();
      input.select();
    }

    /** 创建 Krita 式行内图标按钮。 */
    _createRowIconBtn(icon, label, options) {
      const settings = options || {};
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'layer-row-icon-btn' + (settings.extraClass ? ' ' + settings.extraClass : '');
      btn.setAttribute('data-tooltip', label);
      btn.setAttribute('aria-label', label);
      if (settings.disabled) btn.disabled = true;
      btn.appendChild(MaterialIcons.createIcon(icon, 'layer-row-icon'));
      return btn;
    }

    _render() {
      if (!this.listEl) return;
      this._cancelRename();
      this.listEl.innerHTML = '';
      this._buildDisplayList().forEach(({ layer, depth }) => {
        const isGroup = this._isGroupLayer(layer);
        const isActive = layer.layer_id === this.activeLayerId;
        const row = document.createElement('div');
        row.className = 'layer-row'
          + (isActive ? ' is-active' : '')
          + (isGroup ? ' is-group' : '')
          + (layer.visible === false ? ' is-hidden' : '')
          + (layer.locked ? ' is-locked' : '');
        row.dataset.layerId = layer.layer_id;
        row.style.paddingLeft = (2 + depth * 12) + 'px';

        if (isGroup) {
          const collapsed = this._collapsedGroups.has(layer.layer_id);
          const foldBtn = this._createRowIconBtn(
            collapsed ? 'chevron_right' : 'expand_more',
            collapsed ? '展开图层组' : '折叠图层组'
          );
          foldBtn.classList.add('layer-row-fold-btn');
          foldBtn.addEventListener('click', event => {
            event.stopPropagation();
            this._toggleGroupCollapsed(layer.layer_id);
          });
          row.appendChild(foldBtn);
        }

        const grip = document.createElement('span');
        grip.className = 'layer-row-grip';
        grip.setAttribute('aria-hidden', 'true');
        grip.appendChild(MaterialIcons.createIcon('drag_indicator', 'layer-row-grip-icon'));

        const visBtn = this._createRowIconBtn(
          layer.visible !== false ? 'visibility' : 'visibility_off',
          layer.visible !== false ? '隐藏图层' : '显示图层'
        );
        visBtn.setAttribute('aria-pressed', layer.visible === false ? 'false' : 'true');
        visBtn.addEventListener('click', event => {
          event.stopPropagation();
          this.onUpdate(layer.layer_id, { visible: layer.visible === false });
        });

        const check = document.createElement('span');
        check.className = 'layer-row-check' + (isActive ? ' is-checked' : '');
        check.setAttribute('aria-hidden', 'true');
        if (isActive) {
          check.appendChild(MaterialIcons.createIcon('check', 'layer-row-check-icon'));
        }

        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'layer-row-thumb' + (isGroup ? ' layer-row-thumb--group' : '');
        if (isGroup) {
          thumbWrap.appendChild(MaterialIcons.createIcon('folder', 'layer-row-folder-icon'));
        } else {
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.className = 'layer-row-thumb-canvas';
          thumbCanvas.width = global.LayerThumbnail ? LayerThumbnail.THUMB_SIZE : 36;
          thumbCanvas.height = global.LayerThumbnail ? LayerThumbnail.THUMB_SIZE : 36;
          thumbCanvas.setAttribute('aria-hidden', 'true');
          thumbWrap.appendChild(thumbCanvas);
        }

        const typeIcon = document.createElement('span');
        typeIcon.className = 'layer-row-type';
        typeIcon.setAttribute('data-tooltip', isGroup ? '图层组' : '绘画图层');
        typeIcon.appendChild(MaterialIcons.createIcon(isGroup ? 'folder' : 'brush', 'layer-row-type-icon'));

        const name = document.createElement('span');
        name.className = 'layer-row-name';
        name.textContent = layer.name || layer.layer_id;
        this._bindNameLabel(name, layer);

        const actions = document.createElement('div');
        actions.className = 'layer-row-actions';

        const lockBtn = this._createRowIconBtn(layer.locked ? 'lock' : 'lock_open', layer.locked ? '解锁图层' : '锁定图层');
        lockBtn.setAttribute('aria-pressed', layer.locked ? 'true' : 'false');
        lockBtn.addEventListener('click', event => {
          event.stopPropagation();
          this.onUpdate(layer.layer_id, { locked: !layer.locked });
        });

        const alphaBtn = document.createElement('button');
        alphaBtn.type = 'button';
        alphaBtn.className = 'layer-row-icon-btn layer-row-icon-btn--stub layer-row-alpha-btn';
        alphaBtn.setAttribute('data-tooltip', '继承 Alpha · 即将推出');
        alphaBtn.setAttribute('aria-label', '继承 Alpha');
        alphaBtn.disabled = true;
        alphaBtn.textContent = 'α';
        const transBtn = this._createRowIconBtn('grid_on', '锁定透明像素 · 即将推出', {
          disabled: true,
          extraClass: 'layer-row-icon-btn--stub'
        });

        actions.appendChild(lockBtn);
        actions.appendChild(alphaBtn);
        actions.appendChild(transBtn);

        row.appendChild(grip);
        row.appendChild(visBtn);
        row.appendChild(check);
        row.appendChild(thumbWrap);
        row.appendChild(typeIcon);
        row.appendChild(name);
        row.appendChild(actions);

        row.addEventListener('click', () => this.onSwitch(layer.layer_id));
        row.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          this._showContextMenu(layer, event.clientX, event.clientY);
        });
        this.listEl.appendChild(row);
      });
      this.refreshThumbnails();
    }
  }

  global.LayerPanel = LayerPanel;
})(window);
