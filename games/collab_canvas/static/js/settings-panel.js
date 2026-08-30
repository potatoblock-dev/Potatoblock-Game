(function (global) {
  'use strict';

  const MODE_LABELS = {
    hsv: 'HSV 方框',
    wheel: '色轮',
    rgb: 'RGB',
    hsl: 'HSL'
  };

  /** 顶栏设置弹窗：常规 / 外设 / 快捷键 / 网络 Tab。 */
  class SettingsPanel {
    constructor(options) {
      const settings = options || {};
      this.modal = settings.modal || document.getElementById('settingsModal');
      this.toggleBtn = settings.toggle || document.getElementById('settingsToggleBtn');
      this.closeBtn = this.modal && this.modal.querySelector('[data-settings-close]');
      this.backdrop = this.modal && this.modal.querySelector('[data-settings-backdrop]');
      this.tabs = this.modal ? this.modal.querySelectorAll('[data-settings-tab]') : [];
      this.panes = this.modal ? this.modal.querySelectorAll('[data-settings-pane]') : [];
      this.colorPicker = settings.colorPicker || null;
      this.penInput = settings.penInput || null;
      this.getBrushSize = settings.getBrushSize || (() => 8);
      this.getBrushColor = settings.getBrushColor || (() => '#111827');
      this.viewport = settings.viewport || null;
      this.shortcutManager = settings.shortcutManager || null;
      this.networkMonitor = settings.networkMonitor || null;
      this.recentColors = settings.recentColors || null;
      this.onOpen = settings.onOpen || (() => {});
      this._activeTab = 'general';

      this.modeSelect = this.modal && this.modal.querySelector('#settingsColorMode');
      this.penToggle = this.modal && this.modal.querySelector('#settingsPenPressure');
      this.penSens = this.modal && this.modal.querySelector('#settingsPenSensitivity');
      this.penSensOut = this.modal && this.modal.querySelector('#settingsPenSensitivityOut');
      this.resetViewBtn = this.modal && this.modal.querySelector('#settingsResetView');
      this.recentOrderSelect = this.modal && this.modal.querySelector('#settingsRecentOrder');
      this.recentLimitInput = this.modal && this.modal.querySelector('#settingsRecentLimit');
      this.fillToleranceInput = this.modal && this.modal.querySelector('#settingsFillTolerance');
      this.fillToleranceOut = this.modal && this.modal.querySelector('#settingsFillToleranceOut');
      this.wandToleranceInput = this.modal && this.modal.querySelector('#settingsWandTolerance');
      this.wandToleranceOut = this.modal && this.modal.querySelector('#settingsWandToleranceOut');
      this.swapSidebarsToggle = this.modal && this.modal.querySelector('#settingsSwapSidebars');
      this.getDrawingBoard = settings.getDrawingBoard || (() => null);
      this.getBoardController = settings.getBoardController || (() => null);
      this.onlinePrefs = settings.onlinePrefs || null;
      this.uiPrefs = settings.uiPrefs || null;
      this.session = settings.session || null;
      this.getNickname = settings.getNickname || (() => '玩家');
      this.displayNameInput = this.modal && this.modal.querySelector('#settingsOnlineDisplayName');
      this.usePassportToggle = this.modal && this.modal.querySelector('#settingsOnlineUsePassportName');
      this.labelColorMount = this.modal && this.modal.querySelector('#settingsOnlineLabelColorMount');
      this.labelColorReset = this.modal && this.modal.querySelector('#settingsOnlineLabelReset');
      this.labelPreview = this.modal && this.modal.querySelector('#settingsOnlineLabelPreview');
      this._labelColorSurface = null;
      this.shortcutList = this.modal && this.modal.querySelector('[data-shortcut-list]');
      this.shortcutStatus = this.modal && this.modal.querySelector('[data-shortcut-status]');
      this.shortcutResetBtn = this.modal && this.modal.querySelector('[data-shortcut-reset]');
      this.penTestCanvas = this.modal && this.modal.querySelector('#penTestCanvas');
      this.penTestPressure = this.modal && this.modal.querySelector('[data-pen-test-pressure]');
      this.penTestPad = this.penTestCanvas ? new PenTestPad(this.penTestCanvas, {
        penInput: this.penInput,
        getBaseSize: () => this.getBrushSize(),
        getColor: () => this.getBrushColor(),
        pressureEl: this.penTestPressure
      }) : null;

      this._bindModal();
      this._bindTabs();
      this._bindGeneral();
      this._bindUi();
      this._bindPeripheral();
      this._bindOnline();
      this._renderShortcuts();
      if (this.shortcutResetBtn) {
        this.shortcutResetBtn.addEventListener('click', () => {
          if (this.shortcutManager) {
            this.shortcutManager.resetDefaults();
            this._renderShortcuts();
          }
        });
      }
      if (this.shortcutManager) {
        this.shortcutManager.onCaptureChange = () => this._renderShortcuts();
        this.shortcutManager.onStatus = text => {
          if (this.shortcutStatus) this.shortcutStatus.textContent = text || '';
        };
      }
    }

    isOpen() {
      return this.modal && !this.modal.classList.contains('hidden');
    }

    open() {
      if (!this.modal) return;
      this.onOpen();
      if (this.swapSidebarsToggle && this.uiPrefs) {
        this.swapSidebarsToggle.checked = this.uiPrefs.getSwapSidebars();
        this.uiPrefs.applyToWorkspace();
      }
      this.modal.classList.remove('hidden');
      this._switchTab(this._activeTab || 'general');
    }

    close() {
      if (!this.modal) return;
      this.modal.classList.add('hidden');
      if (this.penTestPad) this.penTestPad.deactivate();
      if (this.shortcutManager) this.shortcutManager.cancelCapture();
      if (this.networkMonitor) this.networkMonitor.setActive(false);
    }

    toggle() {
      if (this.isOpen()) this.close();
      else this.open();
    }

    _bindModal() {
      if (this.toggleBtn) {
        this.toggleBtn.addEventListener('click', event => {
          event.stopPropagation();
          this.toggle();
        });
      }
      if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.close());
      if (this.backdrop) {
        this.backdrop.addEventListener('click', event => {
          if (event.target === this.backdrop) this.close();
        });
      }
      document.addEventListener('keydown', event => {
        if (!this.isOpen()) return;
        if (event.key === 'Escape' && !this.shortcutManager?.capturing) {
          event.preventDefault();
          event.stopPropagation();
          this.close();
        }
      }, true);
    }

    _bindTabs() {
      this.tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const id = tab.getAttribute('data-settings-tab');
          if (id) this._switchTab(id);
        });
      });
    }

    _switchTab(tabId) {
      this._activeTab = tabId;
      this.tabs.forEach(tab => {
        tab.classList.toggle('is-active', tab.getAttribute('data-settings-tab') === tabId);
      });
      this.panes.forEach(pane => {
        pane.classList.toggle('is-active', pane.getAttribute('data-settings-pane') === tabId);
      });
      if (this.networkMonitor) {
        this.networkMonitor.setActive(tabId === 'network');
      }
      if (this.penTestPad) {
        if (tabId === 'peripheral') this.penTestPad.activate();
        else this.penTestPad.deactivate();
      }
      if (tabId === 'shortcuts') this._renderShortcuts();
    }

    _bindGeneral() {
      if (this.modeSelect && this.colorPicker) {
        this.modeSelect.value = this.colorPicker.getMode();
        this.modeSelect.addEventListener('change', () => {
          this.colorPicker.setMode(this.modeSelect.value);
        });
      }
      if (this.recentOrderSelect && this.recentColors) {
        this.recentOrderSelect.value = this.recentColors.getOrder();
        this.recentOrderSelect.addEventListener('change', () => {
          this.recentColors.setOrder(this.recentOrderSelect.value);
        });
      }
      if (this.recentLimitInput && this.recentColors) {
        const limits = (typeof RecentColorsLimits !== 'undefined' ? RecentColorsLimits : { MIN_LIMIT: 2, MAX_LIMIT: 24 });
        this.recentLimitInput.min = String(limits.MIN_LIMIT);
        this.recentLimitInput.max = String(limits.MAX_LIMIT);
        this.recentLimitInput.value = String(this.recentColors.getMaxLimit());
        this.recentLimitInput.addEventListener('change', () => {
          this.recentColors.setMaxLimit(this.recentLimitInput.value);
          this.recentLimitInput.value = String(this.recentColors.getMaxLimit());
        });
      }
      if (this.resetViewBtn && this.viewport) {
        this.resetViewBtn.addEventListener('click', () => {
          this.viewport.resetView();
        });
      }
      const board = this.getDrawingBoard();
      if (this.fillToleranceInput && board) {
        this.fillToleranceInput.value = String(board.fillTolerance);
        if (this.fillToleranceOut) this.fillToleranceOut.textContent = String(board.fillTolerance);
        this.fillToleranceInput.addEventListener('input', () => {
          board.fillTolerance = Number(this.fillToleranceInput.value) || 20;
          if (this.fillToleranceOut) this.fillToleranceOut.textContent = String(board.fillTolerance);
        });
      }
      const controller = this.getBoardController();
      if (this.wandToleranceInput && controller) {
        this.wandToleranceInput.value = String(controller.wandTolerance);
        if (this.wandToleranceOut) this.wandToleranceOut.textContent = String(controller.wandTolerance);
        this.wandToleranceInput.addEventListener('input', () => {
          controller.wandTolerance = Number(this.wandToleranceInput.value) || 20;
          if (this.wandToleranceOut) this.wandToleranceOut.textContent = String(controller.wandTolerance);
        });
      }
    }

    /** 联机 Tab：显示名称、标签底色与预览。 */
    _bindOnline() {
      if (!this.onlinePrefs) return;
      const syncPreview = () => {
        if (!this.labelPreview) return;
        const stored = this.onlinePrefs.getLabelColor();
        const labelColor = stored || defaultLabelColor('self-preview');
        this.labelPreview.textContent = this.onlinePrefs.resolveDisplayName(this.getNickname());
        this.labelPreview.style.background = labelColor;
        this.labelPreview.style.color = contrastText(labelColor);
      };
      const syncNameControls = () => {
        const usePassport = this.onlinePrefs.getUsePassportName();
        if (this.usePassportToggle) this.usePassportToggle.checked = usePassport;
        if (this.displayNameInput) {
          this.displayNameInput.value = this.onlinePrefs.getCustomDisplayName();
          this.displayNameInput.disabled = usePassport;
        }
        syncPreview();
      };
      const pushStyle = () => {
        if (!this.session) return;
        this.session.sendPlayerStyle({
          label_color: this.onlinePrefs.getWireLabelColor(),
          display_name: this.onlinePrefs.resolveDisplayName(this.getNickname())
        });
      };
      const applyStored = () => {
        const stored = this.onlinePrefs.getLabelColor();
        const color = stored || '#3b82f6';
        if (this._labelColorSurface) this._labelColorSurface.setColor(color);
        syncNameControls();
      };
      if (this.labelColorMount) {
        this._labelColorSurface = new ColorPickerSurface(this.labelColorMount, {
          mode: 'hsv',
          color: this.onlinePrefs.getLabelColor() || '#3b82f6',
          showRgbSliders: true,
          onChange: hex => {
            this.onlinePrefs.setLabelColor(hex);
            syncPreview();
            pushStyle();
          },
          onCommit: () => {}
        });
      }
      applyStored();
      if (this.usePassportToggle) {
        this.usePassportToggle.addEventListener('change', () => {
          this.onlinePrefs.setUsePassportName(this.usePassportToggle.checked);
          syncNameControls();
          pushStyle();
        });
      }
      if (this.displayNameInput) {
        this.displayNameInput.addEventListener('input', () => {
          if (this.labelPreview) {
            const usePassport = this.usePassportToggle && this.usePassportToggle.checked;
            const previewName = usePassport
              ? this.onlinePrefs.resolveDisplayName(this.getNickname())
              : (this.displayNameInput.value.trim() || this.getNickname() || '玩家');
            this.labelPreview.textContent = previewName;
          }
        });
        this.displayNameInput.addEventListener('change', () => {
          this.onlinePrefs.setCustomDisplayName(this.displayNameInput.value);
          syncNameControls();
          pushStyle();
        });
      }
      if (this.labelColorReset) {
        this.labelColorReset.addEventListener('click', () => {
          this.onlinePrefs.resetLabelColor();
          applyStored();
          pushStyle();
        });
      }
    }

    /** 绑定用户界面偏好（本机）。 */
    _bindUi() {
      if (this.swapSidebarsToggle && this.uiPrefs) {
        this.swapSidebarsToggle.checked = this.uiPrefs.getSwapSidebars();
        this.swapSidebarsToggle.addEventListener('change', () => {
          this.uiPrefs.setSwapSidebars(this.swapSidebarsToggle.checked);
        });
      }
    }

    /** 外设 Tab：笔压开关、灵敏度与本地测试画板。 */
    _bindPeripheral() {
      if (this.penToggle && this.penInput) {
        this.penToggle.checked = this.penInput.enabled;
        this.penToggle.addEventListener('change', () => {
          this.penInput.setEnabled(this.penToggle.checked);
        });
      }
      if (this.penSens && this.penInput) {
        this.penSens.value = String(Math.round(this.penInput.sensitivity * 100));
        if (this.penSensOut) this.penSensOut.textContent = this.penSens.value + '%';
        this.penSens.addEventListener('input', () => {
          this.penInput.setSensitivity(Number(this.penSens.value));
          if (this.penSensOut) this.penSensOut.textContent = this.penSens.value + '%';
        });
      }
    }

    _renderShortcuts() {
      if (!this.shortcutList || !this.shortcutManager) return;
      const bindings = this.shortcutManager.getBindings();
      const capturing = this.shortcutManager.capturing;
      this.shortcutList.innerHTML = '';

      const categories = {};
      Object.keys(ShortcutRegistry.ACTION_DEFS).forEach(actionId => {
        const def = ShortcutRegistry.ACTION_DEFS[actionId];
        if (!categories[def.category]) categories[def.category] = [];
        categories[def.category].push(actionId);
      });

      Object.keys(ShortcutRegistry.CATEGORY_LABELS).forEach(category => {
        const actions = categories[category];
        if (!actions || !actions.length) return;
        const head = document.createElement('div');
        head.className = 'shortcut-category-head';
        head.textContent = ShortcutRegistry.CATEGORY_LABELS[category];
        this.shortcutList.appendChild(head);

        actions.forEach(actionId => {
          const def = ShortcutRegistry.ACTION_DEFS[actionId];
          const row = document.createElement('div');
          row.className = 'shortcut-row';
          const label = document.createElement('span');
          label.className = 'shortcut-row-label';
          label.textContent = def.label;
          row.appendChild(label);

          [0, 1].forEach(slotIndex => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'shortcut-bind-btn';
            const isCapturing = capturing
              && capturing.actionId === actionId
              && capturing.slotIndex === slotIndex;
            btn.textContent = isCapturing
              ? '请按键…'
              : formatShortcut(bindings[actionId][slotIndex]);
            btn.addEventListener('click', () => {
              this.shortcutManager.startCapture(actionId, slotIndex);
              if (this.shortcutStatus) {
                this.shortcutStatus.textContent = '正在设置「' + def.label + '」'
                  + (slotIndex === 0 ? '主键' : '副键') + '，Esc 取消';
              }
            });
            btn.addEventListener('contextmenu', event => {
              event.preventDefault();
              this.shortcutManager.clearBinding(actionId, slotIndex);
              this._renderShortcuts();
            });
            row.appendChild(btn);
          });
          this.shortcutList.appendChild(row);
        });
      });
    }

    /** 填充取色模式下拉选项。 */
    static fillModeOptions(select) {
      if (!select) return;
      select.innerHTML = '';
      ColorSettings.MODES.forEach(mode => {
        const opt = document.createElement('option');
        opt.value = mode;
        opt.textContent = MODE_LABELS[mode] || mode;
        select.appendChild(opt);
      });
    }
  }

  global.SettingsPanel = SettingsPanel;
})(window);
