const { ls } = require('./storage');
const { socket } = require('./socket');
const { panels } = require('./panels');
const { serviceWorkerHelper } = require('./serviceworkers');
const { settings } = require('./settings');
const { modal } = require('./modal');
const { TH } = require('./typeahead');
let uiHelper;
let user;
let place;
let board;

const { intToHex } = require('./helpers');

const chat = (function() {
  const self = {
    seenHistory: false,
    stickToBottom: true,
    repositionTimer: false,
    pings: 0,
    pingsList: [],
    pingAudio: new Audio('chatnotify.wav'),
    lastPingAudioTimestamp: 0,
    last_opened_panel: ls.get('chat.last_opened_panel') >> 0,
    idLog: [],
    typeahead: {
      helper: null,
      suggesting: false,
      hasResults: false,
      highlightedIndex: 0,
      lastLength: false,
      get shouldInsert() {
        return self.typeahead.suggesting && self.typeahead.hasResults && self.typeahead.highlightedIndex !== -1;
      }
    },
    ignored: [],
    chatban: {
      banned: false,
      banStart: 0,
      banEnd: 0,
      permanent: false,
      banEndFormatted: '',
      timeLeft: 0,
      timer: 0
    },
    timeout: {
      ends: 0,
      timer: 0
    },
    elements: {
      message_icon: $('#message-icon'),
      panel_trigger: $('.panel-trigger[data-panel=chat]'),
      ping_counter: $('#ping-counter'),
      input: $('#txtChatContent'),
      body: $('#chat-body'),
      rate_limit_overlay: $('.chat-ratelimit-overlay'),
      rate_limit_counter: $('#chat-ratelimit'),
      chat_panel: $('.panel[data-panel=chat]'),
      chat_hint: $('#chat-hint'),
      chat_settings_button: $('#btnChatSettings'),
      pings_button: $('#btnPings'),
      jump_button: $('#jump-to-bottom'),
      emoji_button: $('#emojiPanelTrigger'),
      typeahead: $('#typeahead'),
      typeahead_list: $('#typeahead ul'),
      ping_audio_volume_value: $('#chat-pings-audio-volume-value'),
      username_color_select: $('#selChatUsernameColor'),
      username_color_feedback_label: $('#lblChatUsernameColorFeedback'),
      user_ignore_select: $('#selChatUserIgnore'),
      user_unignore_button: $('#btnChatUserUnignore'),
      user_ignore_feedback_label: $('#lblChatUserIgnoreFeedback')
    },
    picker: null,
    markdownProcessor: null,
    TEMPLATE_ACTIONS: {
      ASK: {
        id: 'ask',
        pretty: 'Ask'
      },
      NEW_TAB: {
        id: 'new tab',
        pretty: 'Open in a new tab'
      },
      CURRENT_TAB: {
        id: 'current tab',
        pretty: 'Open in current tab (replacing template)'
      },
      JUMP_ONLY: {
        id: 'jump only',
        pretty: 'Jump to coordinates without replacing template'
      }
    },
    init: () => {
      uiHelper = require('./uiHelper').uiHelper;
      user = require('./user').user;
      place = require('./place').place;
      board = require('./board').board;
      // NOTE(netux): The processor is deriverately left unfrozen to allow for extending
      // it through third party extensions.
      self.markdownProcessor = uiHelper.makeMarkdownProcessor()
        .use(function() {
          this.Compiler.prototype.visitors.link = (node, next) => {
            const url = new URL(node.url, location.href);

            const hashParams = new URLSearchParams(url.hash.substr(1));
            const getParam = (name) => hashParams.has(name) ? hashParams.get(name) : url.searchParams.get(name);

            const coordsX = parseFloat(getParam('x'));
            const coordsY = parseFloat(getParam('y'));

            const isSameOrigin = location.origin && url.origin && location.origin === url.origin;
            if (isSameOrigin && !isNaN(coordsX) && !isNaN(coordsY) && board.validateCoordinates(coordsX, coordsY)) {
              const scale = parseFloat(getParam('scale'));
              return self._makeCoordinatesElement(url.toString(), coordsX, coordsY, isNaN(scale) ? 20 : scale, getParam('template'), getParam('title'));
            } else {
              return crel('a', { href: node.url, target: '_blank' }, next());
            }
          };

          this.Compiler.prototype.visitors.coordinate =
            (node, next) => self._makeCoordinatesElement(node.url, node.x, node.y, node.scale);
        });

      self.reloadIgnores();
      socket.on('chat_user_update', e => {
        if (e.who && e.updates && typeof (e.updates) === 'object') {
          for (const update of Object.entries(e.updates)) {
            switch (update[0]) {
              case 'NameColor': {
                self._updateAuthorNameColor(e.who, Math.floor(update[1]));
                break;
              }
              case 'DisplayedFaction': {
                self._updateAuthorDisplayedFaction(e.who, update[1]);
                break;
              }
              default: {
                console.warn('Got an unknown chat_user_update from %o: %o (%o)', e.who, update, e);
                break;
              }
            }
          }
        } else console.warn('Malformed chat_user_update: %o', e);
      });
      socket.on('faction_update', e => self._updateFaction(e.faction));
      socket.on('faction_clear', e => self._clearFaction(e.fid));
      socket.on('chat_history', e => {
        if (self.seenHistory) return;
        for (const packet of e.messages.reverse()) {
          self._process(packet, true);
        }
        const last = self.elements.body.find('li[data-id]').last()[0];
        if (last) {
          self._doScroll(last);
          if (last.dataset.id && last.dataset.id > ls.get('chat-last_seen_id')) {
            self.elements.message_icon.addClass('has-notification');
          }
        }
        self.seenHistory = true;
        self.addServerAction('History loaded at ' + moment().format('MMM Do YYYY, hh:mm:ss A'));
        setTimeout(() => socket.send({ type: 'ChatbanState' }), 0);
      });
      socket.on('chat_message', e => {
        self._process(e.message);
        const isChatOpen = panels.isOpen('chat');
        if (!isChatOpen) {
          self.elements.message_icon.addClass('has-notification');
        }
        if (self.stickToBottom) {
          const chatLine = self.elements.body.find(`[data-id="${e.message.id}"]`)[0];
          if (chatLine) {
            if (isChatOpen && uiHelper.tabHasFocus()) {
              ls.set('chat-last_seen_id', e.message.id);
            }
            self._doScroll(chatLine);
          }
        }
      });
      serviceWorkerHelper.addMessageListener('focus', ({ data }) => {
        if (uiHelper.tabId === data.id && panels.isOpen('chat')) {
          const chatLine = self.elements.body.find('.chat-line[data-id]').last()[0];
          if (chatLine) {
            ls.set('chat-last_seen_id', chatLine.dataset.id);
          }
        }
      });
      socket.on('message_cooldown', e => {
        self.timeout.ends = (new Date() >> 0) + ((e.diff >> 0) * 1e3) + 1e3; // add 1 second so that we're 1-based instead of 0-based
        if (uiHelper.tabHasFocus()) {
          self.elements.input.val(e.message);
        }
        if ((new Date() >> 0) > self.timeout.ends) {
          self.elements.rate_limit_overlay.fadeOut();
        } else {
          self.elements.rate_limit_overlay.fadeIn();
        }
        if (self.timeout.timer > 0) clearInterval(self.timeout.timer);
        self.timeout.timer = setInterval(() => {
          const delta = (self.timeout.ends - (new Date() >> 0)) / 1e3 >> 0;
          self.elements.rate_limit_counter.text(`${delta}s`);
          if (delta <= 0) {
            self.elements.rate_limit_overlay.fadeOut();
            self.elements.rate_limit_counter.text('');
            clearInterval(self.timeout.timer);
            self.timeout.timer = 0;
          }
        }, 100);
      });
      socket.on('chat_lookup', e => {
        if (e.target && Array.isArray(e.history) && Array.isArray(e.chatbans)) {
          // const now = moment();
          const is24h = settings.chat.timestamps['24h'].get() === true;
          const shortFormat = `MMM Do YYYY, ${is24h ? 'HH:mm' : 'hh:mm A'}`;
          const longFormat = `dddd, MMMM Do YYYY, ${is24h ? 'HH:mm:ss' : 'h:mm:ss a'}`;
          const dom = crel('div', { class: 'halves' },
            crel('div', { class: 'side chat-lookup-side' },
              e.history.length > 0 ? ([ // array children are injected as fragments
                crel('h3', { style: 'text-align: center' }, `Last ${e.history.length} messages`),
                crel('hr'),
                crel('ul', { class: 'chat-history chat-body' },
                  e.history.map(message => crel('li', { class: `chat-line ${message.purged ? 'purged' : ''}`.trimRight() },
                    crel('span', { title: moment(message.sent * 1e3).format(longFormat) }, moment(message.sent * 1e3).format(shortFormat)),
                    ' ',
                    (() => {
                      const toRet = crel('span', { class: 'user' }, e.target.username);
                      uiHelper.styleElemWithChatNameColor(toRet, e.target.chatNameColor, 'color');
                      return toRet;
                    })(),
                    ': ',
                    crel('span', { class: 'content' }, message.content)
                  ))
                )
              ]) : ([
                crel('h3', { style: 'text-align: center' }, 'Last Messages'),
                crel('hr'),
                crel('p', 'No message history')
              ])
            ),
            crel('div', { class: 'side chat-lookup-side' },
              crel('h3', { style: 'text-align: center' }, 'Chat Bans'),
              crel('hr'),
              crel('ul', { class: 'chatban-history' },
                e.chatbans.map(chatban => {
                  return crel('li',
                    crel('article', { class: 'chatban' },
                      crel('header',
                        crel('h4', `${chatban.initiator_name} ${chatban.type === 'UNBAN' ? 'un' : ''}banned ${e.target.username}${chatban.type !== 'PERMA' ? '' : ''}`)
                      ),
                      crel('div',
                        crel('table',
                          crel('tbody',
                            crel('tr',
                              crel('th', 'Reason:'),
                              crel('td', chatban.reason || '$No reason provided$')
                            ),
                            crel('tr',
                              crel('th', 'When:'),
                              crel('td', moment(chatban.when * 1e3).format(longFormat))
                            ),
                            chatban.type !== 'UNBAN' ? ([
                              crel('tr',
                                crel('th', 'Length:'),
                                crel('td', (chatban.type.toUpperCase().trim() === 'PERMA') ? 'Permanent' : `${chatban.expiry - chatban.when}s${(chatban.expiry - chatban.when) >= 60 ? ` (${moment.duration(chatban.expiry - chatban.when, 'seconds').humanize()})` : ''}`)
                              ),
                              (chatban.type.toUpperCase().trim() === 'PERMA') ? null : crel('tr',
                                crel('th', 'Expiry:'),
                                crel('td', moment(chatban.expiry * 1e3).format(longFormat))
                              ),
                              crel('tr',
                                crel('th', 'Purged:'),
                                crel('td', String(chatban.purged))
                              )
                            ]) : null
                          )
                        )
                      )
                    )
                  );
                })
              )
            )
          );
          modal.show(modal.buildDom(
            crel('h2', { class: 'modal-title' }, 'Chat Lookup'),
            dom
          ));
        }
      });
      const handleChatban = e => {
        clearInterval(self.timeout.timer);
        self.chatban.banStart = moment.now();
        self.chatban.banEnd = moment(e.expiry);
        self.chatban.permanent = e.permanent;
        self.chatban.banEndFormatted = self.chatban.banEnd.format('MMM Do YYYY, hh:mm:ss A');
        setTimeout(() => {
          clearInterval(self.chatban.timer);
          self.elements.input.prop('disabled', true);
          self.elements.emoji_button.hide();
          if (e.expiry - self.chatban.banStart > 0 && !e.permanent) {
            self.chatban.banned = true;
            self.elements.rate_limit_counter.text('You have been banned from chat.');
            self.addServerAction(`You are banned ${e.permanent ? 'permanently from chat.' : 'until ' + self.chatban.banEndFormatted}`);
            if (e.reason) {
              self.addServerAction(`Ban reason: ${e.reason}`);
            }
            self.chatban.timer = setInterval(() => {
              const timeLeft = self.chatban.banEnd - moment();
              if (timeLeft > 0) {
                self.elements.rate_limit_overlay.show();
                self.elements.rate_limit_counter.text(`Chatban expires in ${Math.ceil(timeLeft / 1e3)}s, at ${self.chatban.banEndFormatted}`);
              } else {
                self.elements.rate_limit_overlay.hide();
                self.elements.rate_limit_counter.text('');
                self.elements.emoji_button.show();
                self._handleChatbanVisualState(true);
              }
            }, 150);
          } else if (e.permanent) {
            self.chatban.banned = true;
            self.elements.rate_limit_counter.text('You have been banned from chat.');
            self.addServerAction(`You are banned from chat${e.permanent ? ' permanently.' : 'until ' + self.chatban.banEndFormatted}`);
            if (e.reason) {
              self.addServerAction(`Ban reason: ${e.reason}`);
            }
          } else if (e.type !== 'chat_ban_state') { // chat_ban_state is a query result, not an action notice.
            self.addServerAction('You have been unbanned from chat.');
            self.elements.rate_limit_counter.text('You cannot use chat while canvas banned.');
            self.chatban.banned = false;
          }
          self._handleChatbanVisualState(self._canChat());
        }, 0);
      };
      socket.on('chat_ban', handleChatban);
      socket.on('chat_ban_state', handleChatban);

      const _doPurge = (elem, e) => {
        if (user.hasPermission('chat.history.purged')) {
          self._markMessagePurged(elem, e);
        } else {
          elem.remove();
        }
      };
      socket.on('chat_purge', e => {
        const lines = Array.from(self.elements.body[0].querySelectorAll(`.chat-line[data-author="${e.target}"]`));
        if (Array.isArray(lines) && lines.length) {
          lines.sort((a, b) => (a.dataset.date >> 0) - (b.dataset.date >> 0));
          for (let i = 0; i < e.amount; i++) {
            const line = lines.pop();
            if (line) {
              _doPurge(line, e);
            } else {
              break;
            }
          }
        } else console.warn(lines, 'was not an array-like, or was empty.');
        if (e.amount >= 2147483647) {
          self.addServerAction(`${e.initiator} purged all messages from ${e.target}.`);
        } else {
          self.addServerAction(`${e.amount} message${e.amount !== 1 ? 's' : ''} from ${e.target} ${e.amount !== 1 ? 'were' : 'was'} purged by ${e.initiator}.`);
        }
      });
      socket.on('chat_purge_specific', e => {
        const lines = [];
        if (e.IDs && e.IDs.length) {
          e.IDs.forEach(x => {
            const line = self.elements.body.find(`.chat-line[data-id="${x}"]`)[0];
            if (line) lines.push(line);
          });
        }
        if (lines.length) {
          lines.forEach(x => _doPurge(x, e));
          self.addServerAction(`${e.IDs.length} message${e.IDs.length !== 1 ? 's' : ''} from ${e.target} ${e.IDs.length !== 1 ? 'were' : 'was'} purged by ${e.initiator}`);
        }
      });

      socket.send({ type: 'ChatHistory' });

      self.elements.rate_limit_overlay.hide();

      self.elements.input.on('keydown', e => {
        e.stopPropagation();
        const toSend = self.elements.input[0].value;
        const trimmed = toSend.trim();
        if ((e.originalEvent.key === 'Enter' || e.originalEvent.which === 13) && !e.shiftKey) {
          e.preventDefault();

          if (trimmed.length === 0) {
            return;
          }

          if (self.timeout.timer) {
            return;
          }

          if (!self.typeahead.shouldInsert) {
            self.typeahead.lastLength = -1;
            self._send(trimmed);
            self.elements.input.val('');
          }
        } else if (e.originalEvent.key === 'Tab' || e.originalEvent.which === 9) {
          e.stopPropagation();
          e.preventDefault();
        }
      }).on('focus', e => {
        if (self.stickToBottom) {
          setTimeout(self.scrollToBottom, 300);
        }
      });

      $(window).on('pxls:chat:userIgnored', (e, who) => {
        Array.from(document.querySelectorAll(`.chat-line[data-author="${who}"]`)).forEach(x => x.remove());
      });

      $(window).on('pxls:panel:opened', (e, which) => {
        if (which === 'chat') {
          ls.set('chat.last_opened_panel', new Date() / 1e3 >> 0);
          self.clearPings();
          const lastN = self.elements.body.find('[data-id]').last()[0];
          if (lastN) {
            ls.set('chat-last_seen_id', lastN.dataset.id);
          }

          if (user.isLoggedIn()) {
            self._handleChatbanVisualState(self._canChat());
          } else {
            self._handleChatbanVisualState(false);
            self.elements.rate_limit_counter.text('You must be logged in to chat');
          }
        }
      });

      window.addEventListener('storage', (ev) => {
        // value updated on another tab
        if (ev.storageArea === window.localStorage && ev.key === 'chat-last_seen_id') {
          const isLastChild = self.elements.body.find(`[data-id="${JSON.parse(ev.newValue)}"]`).is(':last-child');
          if (isLastChild) {
            self.clearPings();
          }
        }
      });

      $(window).on('pxls:user:loginState', (e, isLoggedIn) => {
        self.updateInputLoginState(isLoggedIn);

        self.elements.username_color_select.disabled = isLoggedIn;
        if (isLoggedIn) {
          // add role-gated colors
          self._populateUsernameColor();
          uiHelper.styleElemWithChatNameColor(self.elements.username_color_select[0], user.getChatNameColor());
        }
      });

      $(window).on('mouseup', e => {
        let target = e.target;
        const popup = document.querySelector('.popup');
        if (!popup) return;
        if (e.originalEvent && e.originalEvent.target) { target = e.originalEvent.target; }

        if (target) {
          const closestPopup = target.closest('.popup');
          closestPopup || popup.remove();
        }
      });

      $(window).on('resize', e => {
        const popup = document.querySelector('.popup[data-popup-for]');
        if (!popup) return;
        const cog = document.querySelector(`.chat-line[data-id="${popup.dataset.popupFor}"] [data-action="actions-panel"]`);
        if (!cog) return console.warn('no cog');

        if (self.repositionTimer) clearTimeout(self.repositionTimer);
        self.repositionTimer = setTimeout(() => {
          self._positionPopupRelativeToX(popup, cog);
          self.repositionTimer = false;
        }, 25);
      });

      self.elements.body[0].addEventListener('wheel', e => {
        const popup = document.querySelector('.popup');
        if (popup) popup.remove();
      });

      self.elements.chat_settings_button[0].addEventListener('click', () => {
        settings.filter.search('Chat');
        panels.toggle('settings');
      });

      self.elements.pings_button[0].addEventListener('click', function() {
        const closeHandler = function() {
          if (this && this.closest) {
            const toClose = this.closest('.popup');
            if (toClose) toClose.remove();
          }
        };

        const popupWrapper = crel('div', { class: 'popup panel' });
        const panelHeader = crel('header', { class: 'panel-header' },
          crel('button', { class: 'left panel-closer' }, crel('i', {
            class: 'fas fa-times',
            onclick: closeHandler
          })),
          crel('h2', 'Pings'),
          crel('div', { class: 'right' })
        );
        // const mainPanel = crel('div', { class: 'pane' });

        const pingsList = crel('ul', { class: 'pings-list' }, self.pingsList.map(packet => {
          const _processed = crel('span', self.processMessage(packet.message_raw));
          return crel('li', { title: _processed.textContent }, crel('i', {
            class: 'fas fa-external-link-alt fa-is-left',
            style: 'font-size: .65rem; cursor: pointer;',
            'data-id': packet.id,
            onclick: self._handlePingJumpClick
          }), `${board.snipMode ? '-snip-' : packet.author}: `, _processed);
        }));
        const popup = crel(popupWrapper, panelHeader, crel('div', { class: 'pane pane-full' }, pingsList));
        document.body.appendChild(popup);
        self._positionPopupRelativeToX(popup, this);
        pingsList.scrollTop = pingsList.scrollHeight;
      });

      self.elements.jump_button[0].addEventListener('click', self.scrollToBottom);

      const notifBody = document.querySelector('.panel[data-panel="notifications"] .panel-body');

      self.elements.body.css('font-size', `${settings.chat.font.size.get() >> 0 || 16}px`);
      notifBody.style.fontSize = `${settings.chat.font.size.get() >> 0 || 16}px`;

      self.elements.body.on('scroll', e => {
        self.updateStickToBottom();
        if (self.stickToBottom && self.elements.chat_panel[0].classList.contains('open')) {
          self.clearPings();
        }
        self.elements.jump_button[0].style.display = self.stickToBottom ? 'none' : 'block';
      });

      // settings
      settings.chat.font.size.listen(function(value) {
        if (isNaN(value)) {
          modal.showText('Invalid chat font size. Expected a number between 1 and 72.');
          settings.chat.font.size.set(16);
        } else {
          const val = value >> 0;
          if (val < 1 || val > 72) {
            modal.showText('Invalid chat font size. Expected a number between 1 and 72.');
            settings.chat.font.size.set(16);
          } else {
            self.elements.body.css('font-size', `${val}px`);
            document.querySelector('.panel[data-panel="notifications"] .panel-body').style.fontSize = `${val}px`;
          }
        }
      });

      settings.chat.truncate.max.listen(function(value) {
        if (isNaN(value)) {
          modal.showText('Invalid maximum chat messages. Expected a number greater than 50.');
          settings.chat.truncate.max.set(50);
        } else {
          const val = value >> 0;
          if (val < 50) {
            modal.showText('Invalid maximum chat messages. Expected a number greater than 50.');
            settings.chat.truncate.max.set(50);
          }
        }
      });

      settings.chat.pings.audio.volume.listen(function(value) {
        const parsed = parseFloat(value);
        const volume = isNaN(parsed) ? 1 : parsed;
        self.elements.ping_audio_volume_value.text(`${volume * 100 >> 0}%`);
      });

      settings.chat.badges.enable.listen(function() {
        self._toggleTextIconFlairs();
      });

      settings.chat.factiontags.enable.listen(function() {
        self._toggleFactionTagFlairs();
      });

      const selSettingChatLinksInternalBehavior = $('#setting-chat-links-internal-behavior');
      selSettingChatLinksInternalBehavior.append(
        Object.values(self.TEMPLATE_ACTIONS).map(action =>
          crel('option', { value: action.id }, action.pretty)
        )
      );
      settings.chat.links.internal.behavior.controls.add(selSettingChatLinksInternalBehavior);

      self.elements.username_color_select.disabled = true;

      self.elements.user_ignore_select.append(
        self.getIgnores().sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase())).map(x =>
          crel('option', { value: x }, x)
        )
      );

      self.elements.user_unignore_button.on('click', function() {
        if (self.removeIgnore(self.elements.user_ignore_select.val())) {
          self.elements.user_ignore_select.find(`option[value="${self.elements.user_ignore_select.val()}"]`).remove();
          self.elements.user_ignore_feedback_label.text('User unignored.');
          self.elements.user_ignore_feedback_label.css('color', 'var(--text-red-color)');
          self.elements.user_ignore_feedback_label.css('display', 'block');
          setTimeout(() => self.elements.user_ignore_feedback_label.fadeOut(500), 3000);
        } else if (self.ignored.length === 0) {
          self.elements.user_ignore_feedback_label.text('You haven\'t ignored any users. Congratulations!');
          self.elements.user_ignore_feedback_label.css('color', 'var(--text-red-color)');
          self.elements.user_ignore_feedback_label.css('display', 'block');
          setTimeout(() => self.elements.user_ignore_feedback_label.fadeOut(500), 3000);
        } else {
          self.elements.user_ignore_feedback_label.text('Failed to unignore user. Either they weren\'t actually ignored, or an error occurred. Contact a developer if the problem persists.');
          self.elements.user_ignore_feedback_label.css('color', 'var(--text-red-color)');
          self.elements.user_ignore_feedback_label.css('display', 'block');
          setTimeout(() => self.elements.user_ignore_feedback_label.fadeOut(500), 5000);
        }
      });
    },
    disable: () => {
      panels.setEnabled('chat', false);
      self.elements.username_color_select.attr('disabled', '');
    },
    _handleChatbanVisualState(canChat) {
      if (canChat) {
        self.elements.input.prop('disabled', false);
        self.elements.rate_limit_overlay.hide();
        self.elements.rate_limit_counter.text('');
        self.elements.emoji_button.show();
      } else {
        self.elements.input.prop('disabled', true);
        self.elements.rate_limit_overlay.show();
        self.elements.emoji_button.hide();
      }
    },
    webinit(data) {
      self.setCharLimit(data.chatCharacterLimit);
      self.canvasBanRespected = data.chatRespectsCanvasBan;
      self._populateUsernameColor();
      self.elements.username_color_select.value = user.getChatNameColor();
      self.elements.username_color_select.on('change', function() {
        self.elements.username_color_select.disabled = true;

        const color = this.value >> 0;
        $.post({
          type: 'POST',
          url: '/chat/setColor',
          data: {
            color
          },
          success: () => {
            user.setChatNameColor(color);
            self.updateSelectedNameColor(color);
            self.elements.username_color_feedback_label.innerText = 'Color updated';
          },
          error: (data) => {
            const err = data.responseJSON && data.responseJSON.details ? data.responseJSON.details : data.responseText;
            if (data.status === 200) {
              self.elements.username_color_feedback_label.innerText = err;
            } else {
              self.elements.username_color_feedback_label.innerText = 'Couldn\'t change chat color: ' + err;
            }
          },
          complete: () => {
            self.elements.username_color_select.value = user.getChatNameColor();
            self.elements.username_color_select.disabled = false;
          }
        });
      });

      if (data.chatEnabled) {
        self.customEmoji = data.customEmoji.map(({ name, emoji }) => ({ name, emoji: `./emoji/${emoji}` }));
        self.initEmojiPicker();
        self.initTypeahead();
      } else {
        self.disable();
      }
    },
    initTypeahead() {
      // init DBs
      const dbEmojis = new TH.Database('emoji', {}, false, false, (x) => (twemoji.test(x.value)) ? x.value : ':' + x.key + ':', (x) => (twemoji.test(x.value)) ? `${twemoji.parse(x.value)} :${x.key}:` : `${'<img class="emoji emoji--custom" draggable="false" alt="' + x.key + '" src="' + x.value + '"/>'} :${x.key}:`);
      const dbUsers = new TH.Database('users', {}, false, false, (x) => `@${x.value} `, (x) => `@${x.value}`);

      // add emoji to emoji DB
      if (window.emojiDB) {
        Object.keys(window.emojiDB)
          .sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()))
          .forEach(name => {
            dbEmojis.addEntry(name, window.emojiDB[name]);
          });
      }
      if (self.customEmoji.length > 0) {
        self.customEmoji.forEach(function (emoji) {
          window.emojiDB[emoji.name.toLowerCase()] = emoji.emoji;
          dbEmojis.addEntry(emoji.name, emoji.emoji);
        });
      }

      // init triggers
      const triggerEmoji = new TH.Trigger(':', 'emoji', true, 2);
      const triggerUsers = new TH.Trigger('@', 'users', false);

      // init typeahead
      self.typeahead.helper = new TH.Typeahead([triggerEmoji, triggerUsers], [' '], [dbEmojis, dbUsers]);
      window.th = self.typeahead.helper;

      // attach events
      self.elements.typeahead[0].querySelectorAll('[data-dismiss="typeahead"]').forEach(x => x.addEventListener('click', () => {
        self.resetTypeahead();
        self.elements.input[0].focus();
      }));
      self.elements.input[0].addEventListener('click', () => scan());
      self.elements.input[0].addEventListener('keyup', function(event) {
        switch (event.key || event.code || event.which || event.charCode) {
          case 'Escape':
          case 27: {
            if (self.typeahead.suggesting) {
              event.preventDefault();
              event.stopPropagation();
              event.stopImmediatePropagation();

              self.resetTypeahead();
            }
            break;
          }
          case 'Tab':
          case 9: {
            if (self.typeahead.suggesting) {
              event.preventDefault();
              event.stopPropagation();
              event.stopImmediatePropagation();

              self.selectNextTypeaheadEntry(event.shiftKey ? -1 : 1); // if we're holding shift, walk backwards (up).
              return;
            } else {
              scan();
            }
            break;
          }
          case 'ArrowUp':
          case 38: {
            if (self.typeahead.suggesting) {
              event.preventDefault();
              event.stopPropagation();
              event.stopImmediatePropagation();
              self.selectNextTypeaheadEntry(-1);
              return;
            }
            break;
          }
          case 'ArrowDown':
          case 40: {
            if (self.typeahead.suggesting) {
              event.preventDefault();
              event.stopPropagation();
              event.stopImmediatePropagation();
              self.selectNextTypeaheadEntry(1);
              return;
            }
            break;
          }
          case 'Enter':
          case 13: {
            if (self.typeahead.shouldInsert) {
              event.preventDefault();
              event.stopPropagation();
              event.stopImmediatePropagation();
              const selected = self.elements.typeahead_list[0].querySelector('button[data-insert].active');
              if (selected) {
                self._handleTypeaheadInsert(selected);
              } else {
                const topResult = self.elements.typeahead_list[0].querySelector('li:first-child > button[data-insert]');
                if (topResult) {
                  self._handleTypeaheadInsert(topResult);
                }
              }
              return;
            }
            break;
          }
        }
        // stops it from scanning when we keyup with shift or some other control character.
        if (self.elements.input[0].value.length !== self.typeahead.lastLength) { scan(); }
      });

      function scan() {
        const scanRes = self.typeahead.helper.scan(self.elements.input[0].selectionStart, self.elements.input[0].value);
        let got = false;
        self.typeahead.lastLength = self.elements.input[0].value.length;
        self.typeahead.suggesting = scanRes !== false;
        if (scanRes) {
          got = self.typeahead.helper.suggestions(scanRes);
          self.typeahead.hasResults = got.length > 0;
          if (!got.length) {
            self.elements.typeahead_list[0].innerHTML = '<li class="no-results">No Results</li>'; // no reason to crel this if we're just gonna innerHTML anyway.
          } else {
            self.elements.typeahead_list[0].innerHTML = '';
            const db = self.typeahead.helper.getDatabase(scanRes.trigger.dbType);

            const LIs = got.slice(0, 50).map(x => {
              const el = crel('button', {
                'data-insert': db.inserter(x),
                'data-start': scanRes.start,
                'data-end': scanRes.end,
                onclick: self._handleTypeaheadInsert
              });
              el.innerHTML = db.renderer(x);
              return crel('li', el);
            });
            LIs[0].classList.add('active');
            crel(self.elements.typeahead_list[0], LIs);
          }
        }
        self.elements.typeahead[0].style.display = self.typeahead.suggesting && self.typeahead.hasResults ? 'block' : 'none';
        document.body.classList.toggle('typeahead-open', self.typeahead.suggesting);
      }
    },
    _handleTypeaheadInsert: function(elem) {
      if (this instanceof HTMLElement) elem = this;
      else if (!(elem instanceof HTMLElement)) return console.warn('Got non-elem on handleTypeaheadInsert: %o', elem);
      const start = parseInt(elem.dataset.start);
      const end = parseInt(elem.dataset.end);
      const toInsert = elem.dataset.insert || '';
      if (!toInsert || start >= end) {
        return console.warn('Got invalid data on elem %o.');
      }
      self.elements.input[0].value = self.elements.input[0].value.substring(0, start) + toInsert + self.elements.input[0].value.substring(end);
      self.elements.input[0].focus();
      self.resetTypeahead();
    },
    selectNextTypeaheadEntry(direction) {
      let nextIndex = self.typeahead.highlightedIndex + direction;
      const children = self.elements.typeahead_list[0].querySelectorAll('button[data-insert]');
      if (direction < 0 && nextIndex < 0) { // if we're walking backwards, we need to check for underflow.
        nextIndex = children.length - 1;
      } else if (direction > 0 && nextIndex >= children.length) { // if we're walking forwards, we need to check for overflow.
        nextIndex = 0;
      }
      const lastSelected = children[self.typeahead.highlightedIndex === -1 ? nextIndex : self.typeahead.highlightedIndex];
      if (lastSelected) {
        lastSelected.classList.remove('active');
      }
      children[nextIndex].classList.add('active');
      children[nextIndex].scrollIntoView();
      self.typeahead.highlightedIndex = nextIndex;
    },
    resetTypeahead: () => { // close with reset
      self.typeahead.suggesting = false;
      self.typeahead.hasResults = false;
      self.typeahead.highlightedIndex = 0;
      self.elements.typeahead[0].style.display = 'none';
      self.elements.typeahead_list[0].innerHTML = '';
      document.body.classList.remove('typeahead-open');
    },
    initEmojiPicker() {
      const pickerOptions = {
        position: 'left-start',
        style: 'twemoji',
        zIndex: 30,
        emojiVersion: '13.0'
      };
      if (self.customEmoji.length > 0) pickerOptions.custom = self.customEmoji;
      self.picker = new EmojiButton.EmojiButton(pickerOptions);
      self.picker.on('emoji', emojiObj => {
        if (emojiObj.custom) {
          self.elements.input[0].value += ':' + emojiObj.name + ':';
          self.elements.input[0].focus();
        } else {
          self.elements.input[0].value += emojiObj.emoji;
          self.elements.input[0].focus();
        }
      });
      self.elements.emoji_button.on('click', function() {
        self.picker.pickerVisible ? self.picker.hidePicker() : self.picker.showPicker(this);
        const searchEl = self.picker.pickerEl.querySelector('.emoji-picker__search'); // searchEl is destroyed every time the picker closes. have to re-attach
        if (searchEl) {
          searchEl.addEventListener('keydown', e => e.stopPropagation());
        }
      });
    },
    reloadIgnores: () => { self.ignored = (ls.get('chat.ignored') || '').split(','); },
    saveIgnores: () => ls.set('chat.ignored', (self.ignored || []).join(',')),
    addIgnore: name => {
      if (name.toLowerCase().trim() !== user.getUsername().toLowerCase().trim() && !self.ignored.includes(name)) {
        self.ignored.push(name);
        self.saveIgnores();
        $(window).trigger('pxls:chat:userIgnored', name);
        self.elements.user_ignore_select.append(crel('option', { value: name }, name));
        return true;
      }
      return false;
    },
    removeIgnore: name => {
      const index = self.ignored.indexOf(name);
      if (index >= 0) {
        const spliced = self.ignored.splice(index, 1);
        self.saveIgnores();
        $(window).trigger('pxls:chat:userUnignored', spliced && spliced[0] ? spliced[0] : false);
        self.elements.user_ignore_select.find(`option[value="${name}"]`).remove();
        return spliced && spliced[0];
      }
      return false;
    },
    getIgnores: () => [].concat(self.ignored || []),
    updateStickToBottom() {
      const obj = self.elements.body[0];
      self.stickToBottom = self._numWithinDrift(obj.scrollTop >> 0, obj.scrollHeight - obj.offsetHeight, 2);
    },
    _handlePingJumpClick: function() { // must be es5 for expected behavior. don't upgrade syntax, this is attached as an onclick and we need `this` to be bound by dom bubbles.
      if (this && this.dataset && this.dataset.id) {
        self.scrollToCMID(this.dataset.id);
      }
    },
    scrollToCMID(cmid) {
      const elem = self.elements.body[0].querySelector(`.chat-line[data-id="${cmid}"]`);
      if (elem) {
        self._doScroll(elem);
        const ripAnim = function() {
          elem.removeEventListener('animationend', ripAnim);
          elem.classList.remove('-scrolled-to');
        };
        elem.addEventListener('animationend', ripAnim);
        elem.classList.add('-scrolled-to');
      }
    },
    scrollToBottom() {
      self.elements.body[0].scrollTop = self.elements.body[0].scrollHeight;
      self.stickToBottom = true;
    },
    setCharLimit(num) {
      self.elements.input.prop('maxlength', num);
    },
    isChatBanned: () => {
      return self.chatban.permanent || (self.chatban.banEnd - moment.now() > 0);
    },
    updateInputLoginState: (isLoggedIn) => {
      const isChatBanned = self.isChatBanned();

      if (isLoggedIn && !isChatBanned) {
        self.elements.input.prop('disabled', false);
        self.elements.rate_limit_overlay.hide();
        self.elements.rate_limit_counter.text('');
        self.elements.emoji_button.show();
      } else {
        self.elements.input.prop('disabled', true);
        self.elements.rate_limit_overlay.show();
        if (!isChatBanned) {
          self.elements.rate_limit_counter.text('You must be logged in to chat.');
        }
        self.elements.emoji_button.hide();
      }
    },
    clearPings: () => {
      self.elements.message_icon.removeClass('has-notification');
      self.elements.panel_trigger.removeClass('has-ping');
      self.elements.pings_button.removeClass('has-notification');
      self.pings = 0;
    },
    _numWithinDrift(needle, haystack, drift) {
      return needle >= (haystack - drift) && needle <= (haystack + drift);
    },
    showHint: (msg, isError = false) => {
      self.elements.chat_hint.toggleClass('text-red', isError === true).text(msg);
    },
    addServerAction: msg => {
      const when = moment();
      const toAppend =
          crel('li', { class: 'chat-line server-action' },
            crel('span', { title: when.format('MMM Do YYYY, hh:mm:ss A') }, when.format(settings.chat.timestamps['24h'].get() === true ? 'HH:mm' : 'hh:mm A')),
            document.createTextNode(' - '),
            crel('span', { class: 'content' }, msg)
          );

      self.elements.body.append(toAppend);
      if (self.stickToBottom) {
        self._doScroll(toAppend);
      }
    },
    _send: msg => {
      socket.send({ type: 'ChatMessage', message: msg });
    },
    jump: (x, y, zoom) => {
      if (typeof x !== 'number') { x = parseFloat(x); }
      if (typeof y !== 'number') { y = parseFloat(y); }
      if (zoom == null) { zoom = false; } else if (typeof zoom !== 'number') { zoom = parseFloat(zoom); }

      board.centerOn(x, y);

      if (zoom) {
        board.setScale(zoom, true);
      }
    },
    updateSelectedNameColor: (colorIdx) => {
      self.elements.username_color_select[0].value = colorIdx;
      uiHelper.styleElemWithChatNameColor(self.elements.username_color_select[0], colorIdx);
    },
    _populateUsernameColor: () => {
      const hasPermForColor = (name) => user.hasPermission(`chat.usercolor.${name}`);
      const hasAllDonatorColors = hasPermForColor('donator') || hasPermForColor('donator.*');
      self.elements.username_color_select.empty().append(
        hasPermForColor('rainbow') ? crel('option', { value: -1, class: 'rainbow' }, '*. Rainbow') : null,
        hasAllDonatorColors || hasPermForColor('donator.green') ? crel('option', { value: -2, class: 'donator donator--green' }, '*. Donator Green') : null,
        hasAllDonatorColors || hasPermForColor('donator.gray') ? crel('option', { value: -3, class: 'donator donator--gray' }, '*. Donator Gray') : null,
        place.palette.map(({ name, value: hex }, i) => crel('option', {
          value: i,
          'data-idx': i,
          style: `background-color: #${hex}`
        }, `${i}. ${name}`))
      );
      self.elements.username_color_select[0].value = user.getChatNameColor();
    },
    _updateAuthorNameColor: (author, colorIdx) => {
      self.elements.body.find(`.chat-line[data-author="${author}"] .user`).each(function() {
        uiHelper.styleElemWithChatNameColor(this, colorIdx, 'color');
      });
    },
    _updateAuthorDisplayedFaction: (author, faction) => {
      const tag = (faction && faction.tag) || '';
      const color = faction ? intToHex(faction && faction.color) : null;
      const tagStr = (faction && faction.tag) ? `[${twemoji.parse(faction.tag)}]` : '';
      let ttStr = '';
      if (faction && faction.name != null && faction.id != null) {
        ttStr = `${faction.name} (ID: ${faction.id})`;
      }

      self.elements.body.find(`.chat-line[data-author="${author}"]`).each(function() {
        this.dataset.faction = (faction && faction.id) || '';
        this.dataset.tag = tag;
        $(this).find('.faction-tag').each(function() {
          this.dataset.tag = tag;
          this.style.color = color;
          this.style.display = settings.chat.factiontags.enable.get() === true ? 'initial' : 'none';
          this.innerHTML = tagStr;
          this.setAttribute('title', ttStr);
        });
      });
    },
    _updateFaction: (faction) => {
      if (faction == null || faction.id == null) return;
      const colorHex = `#${('000000' + (faction.color >>> 0).toString(16)).slice(-6)}`;
      self.elements.body.find(`.chat-line[data-faction="${faction.id}"]`).each(function() {
        this.dataset.tag = faction.tag;
        $(this).find('.faction-tag').attr('data-tag', faction.tag).attr('title', `${faction.name} (ID: ${faction.id})`).css('color', colorHex).html(`[${twemoji.parse(faction.tag)}]`);
      });
    },
    _clearFaction: (fid) => {
      if (fid == null) return;
      self.elements.body.find(`.chat-line[data-faction="${fid}"]`).each(function() {
        const _ft = $(this).find('.faction-tag')[0];
        ['tag', 'faction', 'title'].forEach(x => {
          this.dataset[x] = '';
          _ft.dataset[x] = '';
        });
        _ft.innerHTML = '';
      });
    },
    _toggleTextIconFlairs: (enabled = settings.chat.badges.enable.get() === true) => {
      self.elements.body.find('.chat-line .flairs .text-badge').each(function() {
        this.style.display = enabled ? 'initial' : 'none';
      });
    },
    _toggleFactionTagFlairs: (enabled = settings.chat.factiontags.enable.get() === true) => {
      self.elements.body.find('.chat-line:not([data-faction=""]) .flairs .faction-tag').each(function() {
        this.style.display = enabled ? 'initial' : 'none';
      });
    },
    /**
       * All lookup hooks.
       */
    hooks: [],
    /**
       * Registers hooks.
       * @param {...Object} hooks Information about the hook.
       * @param {String} hooks.id An ID for the hook.
       * @param {Function} hooks.get A function that returns an object representing message metadata.
       */
    registerHook: function(...hooks) {
      return self.hooks.push(...$.map(hooks, function(hook) {
        return {
          id: hook.id || 'hook',
          get: hook.get || function() {
          }
        };
      }));
    },
    /**
       * Replace a hook by its ID.
       * @param {String} hookId The ID of the hook to replace.
       * @param {Object} newHook Information about the hook.
       * @param {Function} newHook.get A function that returns an object representing message metadata.
       */
    replaceHook: function(hookId, newHook) {
      delete newHook.id;
      for (const idx in self.hooks) {
        const hook = self.hooks[idx];
        if (hook.id === hookId) {
          self.hooks[idx] = Object.assign(hook, newHook);
          return;
        }
      }
    },
    /**
       * Unregisters a hook by its ID.
       * @param {string} hookId The ID of the hook to unregister.
       */
    unregisterHook: function(hookId) {
      self.hooks = $.grep(self.hooks, function(hook) {
        return hook.id !== hookId;
      });
    },
    _process: (packet, isHistory = false) => {
      if (packet.id) {
        if (self.idLog.includes(packet.id)) {
          return;
        } else {
          self.idLog.unshift(packet.id); // sit this id in front so we short circuit sooner
          if (self.idLog.length > 50) {
            self.idLog.pop(); // ensure we pop off back instead of shift off front
          }
        }
      }

      const hookDatas = self.hooks.map((hook) => Object.assign({}, { pings: [] }, hook.get(packet)));

      if (!board.snipMode) {
        self.typeahead.helper.getDatabase('users').addEntry(packet.author, packet.author);

        if (self.ignored.indexOf(packet.author) >= 0) return;
      }
      let hasPing = !board.snipMode && settings.chat.pings.enable.get() === true && user.isLoggedIn() && hookDatas.some((data) => data.pings.length > 0);
      const when = moment.unix(packet.date);
      const flairs = crel('span', { class: 'flairs' });
      if (Array.isArray(packet.badges)) {
        packet.badges.forEach(badge => {
          switch (badge.type) {
            case 'text': {
              const _countBadgeShow = settings.chat.badges.enable.get() ? 'initial' : 'none';
              crel(flairs, crel('span', {
                class: 'flair text-badge',
                style: `display: ${_countBadgeShow}`,
                title: badge.tooltip || ''
              }, badge.displayName || ''));
              break;
            }
            case 'icon':
              crel(flairs, crel('span', { class: 'flair icon-badge' }, crel('i', {
                class: badge.cssIcon || '',
                title: badge.tooltip || ''
              }, document.createTextNode(' '))));
              break;
          }
        });
      }

      const _facTag = packet.strippedFaction ? packet.strippedFaction.tag : '';
      if (!board.snipMode) {
        const _facColor = packet.strippedFaction ? intToHex(packet.strippedFaction.color) : 0;
        const _facTagShow = packet.strippedFaction && settings.chat.factiontags.enable.get() === true ? 'initial' : 'none';
        const _facTitle = packet.strippedFaction ? `${packet.strippedFaction.name} (ID: ${packet.strippedFaction.id})` : '';

        const _facFlair = crel('span', {
          class: 'flair faction-tag',
          'data-tag': _facTag,
          style: `color: ${_facColor}; display: ${_facTagShow}`,
          title: _facTitle
        });
        _facFlair.innerHTML = `[${twemoji.parse(_facTag)}]`;
        crel(flairs, _facFlair);
      }

      const contentSpan = crel('span', { class: 'content' },
        self.processMessage(packet.message_raw, (username) => {
          if (username === user.getUsername() && !hasPing) {
            hasPing = true;
          }
        })
      );
      let nameClasses = 'user';
      if (Array.isArray(packet.authorNameClass)) nameClasses += ` ${packet.authorNameClass.join(' ')}`;

      // Truncate older chat messages by removing the diff of the current message count and the maximum count.
      const diff = self.elements.body.children().length - settings.chat.truncate.max.get();
      if (diff > 0) {
        self.elements.body.children().slice(0, diff).remove();
      }

      const chatLine = crel('li', {
        'data-id': packet.id,
        'data-tag': !board.snipMode ? _facTag : '',
        'data-faction': !board.snipMode ? (packet.strippedFaction && packet.strippedFaction.id) || '' : '',
        'data-author': packet.author,
        'data-date': packet.date,
        'data-badges': JSON.stringify(packet.badges || []),
        class: `chat-line${hasPing ? ' has-ping' : ''} ${packet.author.toLowerCase().trim() === user.getUsername().toLowerCase().trim() ? 'is-from-us' : ''}`
      },
      crel('span', { title: when.format('MMM Do YYYY, hh:mm:ss A') }, when.format(settings.chat.timestamps['24h'].get() === true ? 'HH:mm' : 'hh:mm A')),
      document.createTextNode(' '),
      flairs,
      crel('span', {
        class: nameClasses,
        style: `color: #${place.getPaletteColorValue(packet.authorNameColor)}`,
        onclick: self._popUserPanel,
        onmousemiddledown: self._addAuthorMentionToChatbox
      }, board.snipMode ? '-snip-' : packet.author),
      document.createTextNode(': '),
      contentSpan,
      document.createTextNode(' '));
      self.elements.body.append(chatLine);

      if (packet.purge) {
        self._markMessagePurged(chatLine, packet.purge);
      }
      if (packet.authorWasShadowBanned) {
        self._markMessageShadowBanned(chatLine);
      }

      if (hasPing) {
        self.pingsList.push(packet);
        if (!((panels.isOpen('chat') && self.stickToBottom) || (packet.date < self.last_opened_panel))) {
          ++self.pings;
          self.elements.panel_trigger.addClass('has-ping');
          self.elements.pings_button.addClass('has-notification');
        }

        const pingAudioState = settings.chat.pings.audio.when.get();
        const canPlayPingAudio = !isHistory && settings.audio.enable.get() &&
            pingAudioState !== 'off' && Date.now() - self.lastPingAudioTimestamp > 5000;
        if ((!panels.isOpen('chat') || !document.hasFocus() || pingAudioState === 'always') &&
            uiHelper.tabHasFocus() && canPlayPingAudio) {
          self.pingAudio.volume = parseFloat(settings.chat.pings.audio.volume.get());
          self.pingAudio.play();
          self.lastPingAudioTimestamp = Date.now();
        }
      }
    },
    processMessage: (str, mentionCallback) => {
      let content = str;
      try {
        const processor = self.markdownProcessor()
          .use(pxlsMarkdown.plugins.mention, { mentionCallback });
        const file = processor.processSync(str);
        content = file.result;
      } catch (err) {
        console.error(`could not process chat message "${str}"`, err, '\nDefaulting to raw content.');
      }

      return content;
    },
    _markMessagePurged: (elem, purge) => {
      elem.classList.add('purged');
      elem.setAttribute('title', `Purged by ${purge.initiator} with reason: ${purge.reason || 'none provided'}`);
      elem.dataset.purgedBy = purge.initiator;
    },
    _markMessageShadowBanned: (elem) => {
      elem.classList.add('shadow-banned');
      elem.dataset.shadowBanned = 'true';
    },
    _makeCoordinatesElement: (raw, x, y, scale, template, title) => {
      let text = `(${x}, ${y}${scale != null ? `, ${scale}x` : ''})`;
      if (template != null && template.length >= 11) { // we have a template, should probably make that known
        const tmplName = decodeURIComponent(
          settings.chat.links.templates.preferurls.get() !== true && title && title.trim()
            ? title
            : template
        );
        text += ` (template: ${(tmplName > 25) ? `${tmplName.substr(0, 22)}...` : tmplName})`;
      }

      function handleClick(e) {
        e.preventDefault();

        if (template) {
          const internalClickDefault = settings.chat.links.internal.behavior.get();
          if (internalClickDefault === self.TEMPLATE_ACTIONS.ASK.id) {
            self._popTemplateOverwriteConfirm(e.target).then(action => {
              modal.closeAll();
              self._handleTemplateOverwriteAction(action, e.target);
            });
          } else {
            self._handleTemplateOverwriteAction(internalClickDefault, e.target);
          }
        } else {
          self.jump(parseFloat(x), parseFloat(y), parseFloat(scale));
        }
      }

      return crel('a', {
        class: 'link coordinates',
        dataset: {
          raw,
          x,
          y,
          scale,
          template,
          title
        },
        href: raw,
        onclick: handleClick
      }, text);
    },
    _handleTemplateOverwriteAction: (action, linkElem) => {
      switch (action) {
        case false:
          break;
        case self.TEMPLATE_ACTIONS.CURRENT_TAB.id: {
          self._pushStateMaybe(); // ensure people can back button if available
          document.location.href = linkElem.dataset.raw; // overwrite href since that will trigger hash-based update of template. no need to re-write that logic
          break;
        }
        case self.TEMPLATE_ACTIONS.JUMP_ONLY.id: {
          self._pushStateMaybe(); // ensure people can back button if available
          self.jump(parseFloat(linkElem.dataset.x), parseFloat(linkElem.dataset.y), parseFloat(linkElem.dataset.scale));
          break;
        }
        case self.TEMPLATE_ACTIONS.NEW_TAB.id: {
          if (!window.open(linkElem.dataset.raw, '_blank')) { // what popup blocker still blocks _blank redirects? idk but i'm sure they exist.
            modal.show(modal.buildDom(
              crel('h2', { class: 'modal-title' }, 'Open Failed'),
              crel('div',
                crel('h3', 'Failed to automatically open in a new tab'),
                crel('a', {
                  href: linkElem.dataset.raw,
                  target: '_blank'
                }, 'Click here to open in a new tab instead')
              )
            ));
          }
          break;
        }
      }
    },
    _popTemplateOverwriteConfirm: (internalJumpElem) => {
      return new Promise((resolve, reject) => {
        const bodyWrapper = crel('div');
        // const buttons = crel('div', { style: 'text-align: right; display: block; width: 100%;' });

        modal.show(modal.buildDom(
          crel('h2', { class: 'modal-title' }, 'Open Template'),
          crel(bodyWrapper,
            crel('h3', { class: 'text-orange' }, 'This link will overwrite your current template. What would you like to do?'),
            Object.values(self.TEMPLATE_ACTIONS).map(action => action.id === self.TEMPLATE_ACTIONS.ASK.id ? null
              : crel('label', { style: 'display: block; margin: 3px 3px 3px 1rem; margin-left: 1rem;' },
                crel('input', {
                  type: 'radio',
                  name: 'link-action-rb',
                  'data-action-id': action.id
                }),
                action.pretty
              )
            ),
            crel('span', { class: 'text-muted' }, 'Note: You can set a default action in the settings menu which bypasses this popup completely.')
          ),
          [
            ['Cancel', () => resolve(false)],
            ['OK', () => resolve(bodyWrapper.querySelector('input[type=radio]:checked').dataset.actionId)]
          ].map(x =>
            crel('button', {
              class: 'text-button',
              style: 'margin-left: 3px; position: initial !important; bottom: initial !important; right: initial !important;',
              onclick: x[1]
            }, x[0])
          )
        ));
        bodyWrapper.querySelector(`input[type="radio"][data-action-id="${self.TEMPLATE_ACTIONS.NEW_TAB.id}"]`).checked = true;
      });
    },
    _pushStateMaybe(url) {
      if ((typeof history.pushState) === 'function') {
        history.pushState(null, document.title, url == null ? document.location.href : url); // ensure people can back button if available
      }
    },
    // The following functions must use es5 syntax for expected behavior.
    // Don't upgrade syntax, `this` is attached to a DOM Event and we need `this` to be bound by DOM Bubbles.
    _addAuthorMentionToChatbox: function(e) {
      e.preventDefault();
      if (this && this.closest) {
        const chatLineEl = this.closest('.chat-line[data-id]');
        if (!chatLineEl) return console.warn('no closets chat-line on self: %o', this);

        self.elements.input.val(self.elements.input.val() + '@' + chatLineEl.dataset.author + ' ');
        self.elements.input.focus();
      }
    },
    _popUserPanel: function(e) {
      if (this && this.closest) {
        const closest = this.closest('.chat-line[data-id]');
        if (!closest) return console.warn('no closets chat-line on self: %o', this);

        const id = closest.dataset.id;

        let badgesArray = [];
        try {
          badgesArray = JSON.parse(closest.dataset.badges);
        } catch (ignored) {
        }
        const badges = crel('span', { class: 'badges' });
        badgesArray.forEach(badge => {
          switch (badge.type) {
            case 'text':
              crel(badges, crel('span', {
                class: 'text-badge',
                title: badge.tooltip || ''
              }, badge.displayName || ''), document.createTextNode(' '));
              break;
            case 'icon':
              crel(badges, crel('i', {
                class: (badge.cssIcon || '') + ' icon-badge',
                title: badge.tooltip || ''
              }, document.createTextNode(' ')), document.createTextNode(' '));
              break;
          }
        });

        const closeHandler = function() {
          if (this && this.closest) {
            const toClose = this.closest('.popup');
            if (toClose) toClose.remove();
          }
        };

        let _factionTag = null;
        if (closest.dataset.tag) {
          _factionTag = document.createElement('span', { class: 'flair faction-tag' });
          _factionTag.innerHTML = `[${twemoji.parse(closest.dataset.tag)}] `;
        }

        const popupWrapper = crel('div', { class: 'popup panel', 'data-popup-for': id });
        const panelHeader = crel('header',
          { class: 'panel-header' },
          crel('button', { class: 'left panel-closer' }, crel('i', {
            class: 'fas fa-times',
            onclick: closeHandler
          })),
          crel('span', _factionTag, closest.dataset.author, badges),
          crel('div', { class: 'right' })
        );
        const leftPanel = crel('div', { class: 'pane details-wrapper chat-line' });
        const rightPanel = crel('div', { class: 'pane actions-wrapper' });
        const actionsList = crel('ul', { class: 'actions-list' });

        const actions = [
          { label: 'Report', action: 'report', class: 'dangerous-button' },
          { label: 'Mention', action: 'mention' },
          { label: 'Ignore', action: 'ignore' },
          (!board.snipMode || App.user.hasPermission('user.receivestaffbroadcasts')) && { label: 'Profile', action: 'profile' },
          { label: 'Chat (un)ban', action: 'chatban', staffaction: true },
          // TODO(netux): Fix infraestructure and allow to purge during snip mode
          !board.snipMode && { label: 'Purge User', action: 'purge', staffaction: true },
          { label: 'Delete', action: 'delete', staffaction: true },
          { label: 'Mod Lookup', action: 'lookup-mod', staffaction: true },
          { label: 'Chat Lookup', action: 'lookup-chat', staffaction: true }
        ];

        crel(leftPanel, crel('p', { class: 'popup-timestamp-header text-muted' }, moment.unix(closest.dataset.date >> 0).format(`MMM Do YYYY, ${(settings.chat.timestamps['24h'].get() === true ? 'HH:mm:ss' : 'hh:mm:ss A')}`)));
        crel(leftPanel, crel('p', { class: 'content', style: 'margin-top: 3px; margin-left: 3px; text-align: left;' }, closest.querySelector('.content').textContent));

        crel(actionsList, actions
          .filter((action) => action && (user.isStaff() || !action.staffaction))
          .map((action) => crel('li', crel('button', {
            type: 'button',
            class: 'text-button fullwidth ' + (action.class || ''),
            'data-action': action.action,
            'data-id': id,
            onclick: self._handleActionClick
          }, action.label))));
        crel(rightPanel, actionsList);

        const popup = crel(popupWrapper, panelHeader, leftPanel, rightPanel);
        document.body.appendChild(popup);
        self._positionPopupRelativeToX(popup, this);
      }
    },
    _positionPopupRelativeToX(popup, x) {
      const bodyRect = document.body.getBoundingClientRect();
      const thisRect = x.getBoundingClientRect(); // this: span.user or i.fas.fa-cog
      let popupRect = popup.getBoundingClientRect();

      if (thisRect.left < (popupRect.width / 2)) {
        popup.style.left = `${thisRect.left >> 0}px`;
      } else {
        popup.style.left = `${((thisRect.left + (thisRect.width / 2 >> 0)) - (popupRect.width / 2 >> 0)) >> 0}px`;
      }

      popup.style.top = `${thisRect.top + thisRect.height + 2}px`;

      popupRect = popup.getBoundingClientRect(); // have to re-calculate after moving before fixing positioning. forces relayout though

      if (popupRect.bottom > bodyRect.bottom) {
        popup.style.bottom = '2px';
        popup.style.top = null;
      }
      if (popupRect.top < bodyRect.top) {
        popup.style.top = '2px';
        popup.style.bottom = null;
      }
      if (popupRect.right > bodyRect.right) {
        popup.style.right = '2px';
        popup.style.left = null;
      }
      if (popupRect.left < bodyRect.left) {
        popup.style.left = '2px';
        popup.style.right = null;
      }
    },
    _handleActionClick: function(e) { // must be es5 for expected behavior. don't upgrade syntax, this is attached as an onclick and we need `this` to be bound by dom bubbles.
      if (!this.dataset) return console.trace('onClick attached to invalid object');

      const chatLine = self.elements.body.find(`.chat-line[data-id="${this.dataset.id}"]`)[0];
      if (!chatLine && !this.dataset.target) return console.warn('no chatLine/target? searched for id %o', this.dataset.id);
      const mode = !!chatLine;

      const reportingMessage = mode ? chatLine.querySelector('.content').textContent : '';
      const reportingTarget = mode ? chatLine.dataset.author : this.dataset.target;

      $('.popup').remove();
      switch (this.dataset.action.toLowerCase().trim()) {
        case 'report': {
          const reportButton = crel('button', {
            class: 'text-button dangerous-button',
            type: 'submit'
          }, 'Report');
          const textArea = crel('textarea', {
            placeholder: 'Enter a reason for your report',
            style: 'width: 100%; border: 1px solid #999;',
            onkeydown: e => e.stopPropagation()
          });

          const chatReport =
              crel('form', { class: 'report chat-report', 'data-chat-id': this.dataset.id },
                crel('p', { style: 'font-size: 1rem !important;' },
                  'You are reporting a chat message from ',
                  crel('span', { style: 'font-weight: bold' }, reportingTarget),
                  crel('span', { title: reportingMessage }, ` with the content "${reportingMessage.substr(0, 60)}${reportingMessage.length > 60 ? '...' : ''}"`)
                ),
                textArea,
                crel('div', { style: 'text-align: right' },
                  crel('button', {
                    class: 'text-button',
                    style: 'position: initial; margin-right: .25rem',
                    type: 'button',
                    onclick: () => {
                      modal.closeAll();
                      chatReport.remove();
                    }
                  }, 'Cancel'),
                  reportButton
                )
              );
          chatReport.onsubmit = e => {
            e.preventDefault();
            reportButton.disabled = true;
            if (!this.dataset.id) return console.error('!! No id to report? !!', this);
            $.post('/reportChat', {
              cmid: this.dataset.id,
              report_message: textArea.value
            }, function() {
              chatReport.remove();
              modal.showText('Sent report!');
            }).fail(function() {
              modal.showText('Error sending report.');
              reportButton.disabled = false;
            });
          };
          modal.show(modal.buildDom(
            crel('h2', { class: 'modal-title' }, 'Report User'),
            chatReport
          ));
          break;
        }
        case 'mention': {
          if (reportingTarget) {
            self.elements.input.val(self.elements.input.val() + `@${reportingTarget} `);
          } else console.warn('no reportingTarget');
          break;
        }
        case 'ignore': {
          if (reportingTarget) {
            if (chat.addIgnore(reportingTarget)) {
              modal.showText('User ignored. You can unignore from chat settings.');
            } else {
              modal.showText('Failed to ignore user. Either they\'re already ignored, or an error occurred. If the problem persists, contact a developer.');
            }
          } else console.warn('no reportingTarget');
          break;
        }
        case 'chatban': {
          const messageTable = mode
            ? crel('table', { class: 'chatmod-table' },
              crel('tr',
                crel('th', 'ID: '),
                crel('td', this.dataset.id)
              ),
              crel('tr',
                crel('th', 'Message: '),
                crel('td', { title: reportingMessage }, `${reportingMessage.substr(0, 120)}${reportingMessage.length > 120 ? '...' : ''}`)
              ),
              crel('tr',
                crel('th', 'User: '),
                crel('td', reportingTarget)
              )
            )
            : crel('table', { class: 'chatmod-table' },
              crel('tr',
                crel('th', 'User: '),
                crel('td', reportingTarget)
              )
            );

          const banLengths = [['Unban', -3], ['Permanent', -1], ['Temporary', -2]];
          const _selBanLength = crel('select', { name: 'selBanLength' },
            banLengths.map(lenPart =>
              crel('option', { value: lenPart[1] }, lenPart[0])
            )
          );

          const _customLenWrap = crel('div', { style: 'display: block; margin-top: .5rem' });
          const _selCustomLength = crel('select', {
            name: 'selCustomLength',
            style: 'display: inline-block; width: auto;'
          },
          crel('option', { value: '1' }, 'Seconds'),
          crel('option', { value: '60' }, 'Minutes'),
          crel('option', { value: '3600' }, 'Hours'),
          crel('option', { value: '86400' }, 'Days')
          );
          const _txtCustomLength = crel('input', {
            type: 'number',
            name: 'txtCustomLength',
            style: 'display: inline-block; width: auto;',
            min: '1',
            step: '1',
            value: '10'
          });

          const _selBanReason = crel('select',
            crel('option', 'Rule 3: Spam'),
            crel('option', 'Rule 1: Chat civility'),
            crel('option', 'Rule 2: Hate Speech'),
            crel('option', 'Rule 5: NSFW'),
            crel('option', 'Custom')
          );

          const _additionalReasonInfoWrap = crel('div', { style: 'margin-top: .5rem;' });
          const _txtAdditionalReason = crel('textarea', {
            type: 'text',
            name: 'txtAdditionalReasonInfo'
          });

          const _purgeWrap = crel('div', { style: 'display: block;' });
          const _rbPurgeYes = crel('input', {
            type: 'radio',
            name: 'rbPurge',
            checked: String(!board.snipMode)
          });
          const _rbPurgeNo = crel('input', { type: 'radio', name: 'rbPurge' });

          const _reasonWrap = crel('div', { style: 'display: block;' });

          const _btnCancel = crel('button', {
            class: 'text-button',
            type: 'button',
            onclick: () => {
              chatbanContainer.remove();
              modal.closeAll();
            }
          }, 'Cancel');
          const _btnOK = crel('button', { class: 'text-button dangerous-button', type: 'submit' }, 'Ban');

          const chatbanContainer = crel('form', {
            class: 'chatmod-container',
            'data-chat-id': this.dataset.id
          },
          crel('h5', mode ? 'Banning:' : 'Message:'),
          messageTable,
          crel('h5', 'Ban Length'),
          _selBanLength,
          crel(_customLenWrap,
            _txtCustomLength,
            _selCustomLength
          ),
          crel(_reasonWrap,
            crel('h5', 'Reason'),
            _selBanReason,
            crel(_additionalReasonInfoWrap, _txtAdditionalReason)
          ),
          crel(_purgeWrap,
            crel('h5', 'Purge Messages'),
            board.snipMode
              ? crel('span', { class: 'text-orange extra-warning' },
                crel('i', { class: 'fas fa-exclamation-triangle' }),
                ' Purging all messages is disabled during snip mode'
              )
              : [
                crel('label', { style: 'display: inline;' }, _rbPurgeYes, 'Yes'),
                crel('label', { style: 'display: inline;' }, _rbPurgeNo, 'No')
              ]
          ),
          crel('div', { class: 'buttons' },
            _btnCancel,
            _btnOK
          )
          );

          _selBanLength.value = banLengths[2][1]; // 10 minutes
          _selBanLength.addEventListener('change', function() {
            const isCustom = this.value === '-2';
            _customLenWrap.style.display = isCustom ? 'block' : 'none';
            _txtCustomLength.required = isCustom;

            const isUnban = _selBanLength.value === '-3';
            _reasonWrap.style.display = isUnban ? 'none' : 'block';
            _purgeWrap.style.display = isUnban ? 'none' : 'block';
            _btnOK.innerHTML = isUnban ? 'Unban' : 'Ban';
          });
          _selCustomLength.selectedIndex = 1; // minutes

          const updateAdditionalTextarea = () => {
            const isCustom = _selBanReason.value === 'Custom';
            _txtAdditionalReason.placeholder = isCustom ? 'Custom reason' : 'Additional information (if applicable)';
            _txtAdditionalReason.required = isCustom;
          };

          updateAdditionalTextarea();
          _selBanReason.addEventListener('change', updateAdditionalTextarea);

          _txtAdditionalReason.onkeydown = e => e.stopPropagation();
          _txtCustomLength.onkeydown = e => e.stopPropagation();

          chatbanContainer.onsubmit = e => {
            e.preventDefault();
            const postData = {
              type: 'temp',
              reason: 'none provided',
              // TODO(netux): Fix infraestructure and allow to purge during snip mode
              removalAmount: !board.snipMode ? (_rbPurgeYes.checked ? -1 : 0) : 0, // message purges are based on username, so if we purge when everyone in chat is -snip-, we aren't gonna have a good time
              banLength: 0
            };

            if (_selBanReason.value === 'Custom') {
              postData.reason = _txtAdditionalReason.value;
            } else {
              postData.reason = _selBanReason.value;
              if (_txtAdditionalReason.value) {
                postData.reason += `. Additional information: ${_txtAdditionalReason.value}`;
              }
            }

            if (_selBanLength.value === '-3') { // unban
              postData.type = 'unban';
              postData.reason = '(web shell unban)';
              postData.banLength = -1;
            } else if (_selBanLength.value === '-2') { // custom
              postData.banLength = (_txtCustomLength.value >> 0) * (_selCustomLength.value >> 0);
            } else if (_selBanLength.value === '-1') { // perma
              postData.type = 'perma';
              postData.banLength = 0;
            } else {
              postData.banLength = _selBanLength.value >> 0;
            }

            if (mode) { postData.cmid = this.dataset.id; } else { postData.who = reportingTarget; }

            $.post('/admin/chatban', postData, () => {
              modal.showText('Chatban initiated');
            }).fail(() => {
              modal.showText('Error occurred while chatbanning');
            });
          };
          modal.show(modal.buildDom(
            crel('h2', { class: 'modal-title' }, 'Chatban'),
            crel('div', { style: 'padding-left: 1em' },
              chatbanContainer
            )
          ));
          break;
        }
        case 'delete': {
          const _txtReason = crel('input', {
            type: 'text',
            name: 'txtReason',
            style: 'display: inline-block; width: 100%; font-family: sans-serif; font-size: 1rem;'
          });

          const dodelete = () => $.post('/admin/delete', {
            cmid: this.dataset.id,
            reason: _txtReason.value
          }, () => {
            modal.closeAll();
          }).fail(() => {
            modal.showText('Failed to delete');
          });

          if (e.shiftKey === true) {
            return dodelete();
          }
          const btndelete = crel('button', { class: 'text-button dangerous-button' }, 'Delete');
          btndelete.onclick = () => dodelete();
          const deleteWrapper = crel('div', { class: 'chatmod-container' },
            crel('table',
              crel('tr',
                crel('th', 'ID: '),
                crel('td', this.dataset.id)
              ),
              crel('tr',
                crel('th', 'User: '),
                crel('td', reportingTarget)
              ),
              crel('tr',
                crel('th', 'Message: '),
                crel('td', { title: reportingMessage }, `${reportingMessage.substr(0, 120)}${reportingMessage.length > 120 ? '...' : ''}`)
              ),
              crel('tr',
                crel('th', 'Reason: '),
                crel('td', _txtReason)
              )
            ),
            crel('div', { class: 'buttons' },
              crel('button', {
                class: 'text-button',
                type: 'button',
                onclick: () => {
                  deleteWrapper.remove();
                  modal.closeAll();
                }
              }, 'Cancel'),
              btndelete
            )
          );
          modal.show(modal.buildDom(
            crel('h2', { class: 'modal-title' }, 'Delete Message'),
            deleteWrapper
          ));
          break;
        }
        case 'purge': {
          const txtPurgeReason = crel('input', { type: 'text', onkeydown: e => e.stopPropagation() });

          const btnPurge = crel('button', { class: 'text-button dangerous-button', type: 'submit' }, 'Purge');

          const messageTable = mode
            ? crel('table',
              crel('tr',
                crel('th', 'ID: '),
                crel('td', this.dataset.id)
              ),
              crel('tr',
                crel('th', 'Message: '),
                crel('td', { title: reportingMessage }, `${reportingMessage.substr(0, 120)}${reportingMessage.length > 120 ? '...' : ''}`)
              )
            )
            : crel('table', { class: 'chatmod-table' },
              crel('tr',
                crel('th', 'User: '),
                crel('td', reportingTarget)
              )
            );

          const purgeWrapper = crel('form', { class: 'chatmod-container' },
            crel('h5', 'Selected Message'),
            messageTable,
            crel('div',
              crel('h5', 'Purge Reason'),
              txtPurgeReason
            ),
            crel('div', { class: 'buttons' },
              crel('button', {
                class: 'text-button',
                type: 'button',
                onclick: () => {
                  purgeWrapper.remove();
                  modal.closeAll();
                }
              }, 'Cancel'),
              btnPurge
            )
          );
          purgeWrapper.onsubmit = e => {
            e.preventDefault();

            $.post('/admin/chatPurge', {
              who: reportingTarget,
              reason: txtPurgeReason.value
            }, function() {
              purgeWrapper.remove();
              modal.showText('User purged');
            }).fail(function() {
              modal.showText('Error sending purge.');
            });
          };
          modal.show(modal.buildDom(
            crel('h2', { class: 'modal-title' }, 'Purge User'),
            crel('div', { style: 'padding-left: 1em' }, purgeWrapper)
          ));
          break;
        }
        case 'lookup-mod': {
          if (user.admin && user.admin.checkUser && user.admin.checkUser.check) {
            const type = board.snipMode ? 'cmid' : 'username';
            const arg = board.snipMode ? this.dataset.id : reportingTarget;
            user.admin.checkUser.check(arg, type);
          }
          break;
        }
        case 'lookup-chat': {
          socket.send({
            type: 'ChatLookup',
            arg: board.snipMode ? this.dataset.id : reportingTarget,
            mode: board.snipMode ? 'cmid' : 'username'
          });
          break;
        }
        case 'request-rename': {
          const rbStateOn = crel('input', { type: 'radio', name: 'rbState' });
          const rbStateOff = crel('input', { type: 'radio', name: 'rbState' });

          const stateOn = crel('label', { style: 'display: inline-block' }, rbStateOn, ' On');
          const stateOff = crel('label', { style: 'display: inline-block' }, rbStateOff, ' Off');

          const btnSetState = crel('button', { class: 'text-button', type: 'submit' }, 'Set');

          const renameError = crel('p', {
            style: 'display: none; color: #f00; font-weight: bold; font-size: .9rem',
            class: 'rename-error'
          }, '');

          rbStateOff.checked = true;

          const renameWrapper = crel('form', { class: 'chatmod-container' },
            crel('h3', 'Toggle Rename Request'),
            crel('p', 'Select one of the options below to set the current rename request state.'),
            crel('div', stateOn, stateOff),
            renameError,
            crel('div', { class: 'buttons' },
              crel('button', {
                class: 'text-button',
                type: 'button',
                onclick: () => {
                  renameWrapper.remove();
                  modal.closeAll();
                }
              }, 'Cancel'),
              btnSetState
            )
          );

          renameWrapper.onsubmit = e => {
            e.preventDefault();
            $.post('/admin/flagNameChange', {
              user: reportingTarget,
              flagState: rbStateOn.checked === true
            }, function() {
              renameWrapper.remove();
              modal.showText('Rename request updated');
            }).fail(function(xhrObj) {
              let resp = 'An unknown error occurred. Please contact a developer';
              if (xhrObj.responseJSON) {
                resp = xhrObj.responseJSON.details || resp;
              } else if (xhrObj.responseText) {
                try {
                  resp = JSON.parse(xhrObj.responseText).details;
                } catch (ignored) {
                }
              }

              renameError.style.display = null;
              renameError.innerHTML = resp;
            });
          };
          modal.show(modal.buildDom(
            crel('h2', { class: 'modal-title' }, 'Request Rename'),
            renameWrapper
          ));
          break;
        }
        case 'force-rename': {
          const newNameInput = crel('input', {
            type: 'text',
            required: 'true',
            onkeydown: e => e.stopPropagation()
          });
          const newNameWrapper = crel('label', 'New Name: ', newNameInput);

          const btnSetState = crel('button', { class: 'text-button', type: 'submit' }, 'Set');

          const renameError = crel('p', {
            style: 'display: none; color: #f00; font-weight: bold; font-size: .9rem',
            class: 'rename-error'
          }, '');

          const renameWrapper = crel('form', { class: 'chatmod-container' },
            crel('p', 'Enter the new name for the user below. Please note that if you\'re trying to change the caps, you\'ll have to rename to something else first.'),
            newNameWrapper,
            renameError,
            crel('div', { class: 'buttons' },
              crel('button', {
                class: 'text-button',
                type: 'button',
                onclick: () => {
                  modal.closeAll();
                }
              }, 'Cancel'),
              btnSetState
            )
          );

          renameWrapper.onsubmit = e => {
            e.preventDefault();
            $.post('/admin/forceNameChange', {
              user: reportingTarget,
              newName: newNameInput.value.trim()
            }, function() {
              modal.showText('User renamed');
            }).fail(function(xhrObj) {
              let resp = 'An unknown error occurred. Please contact a developer';
              if (xhrObj.responseJSON) {
                resp = xhrObj.responseJSON.details || resp;
              } else if (xhrObj.responseText) {
                try {
                  resp = JSON.parse(xhrObj.responseText).details;
                } catch (ignored) {
                }
              }

              renameError.style.display = null;
              renameError.innerHTML = resp;
            });
          };
          modal.show(modal.buildDom(
            crel('h2', { class: 'modal-title' }, 'Force Rename'),
            renameWrapper
          ));
          break;
        }
        case 'profile': {
          if (!window.open(`/profile/${reportingTarget}`, '_blank')) {
            modal.show(modal.buildDom(
              crel('h2', { class: 'modal-title' }, 'Open Failed'),
              crel('div',
                crel('h3', 'Failed to automatically open in a new tab'),
                crel('a', {
                  href: `/profile/${reportingTarget}`,
                  target: '_blank'
                }, 'Click here to open in a new tab instead')
              )
            ));
          }
          break;
        }
      }
    },
    _doScroll: elem => {
      try { // Fixes iframes scrolling their parent. For context see https://github.com/pxlsspace/Pxls/pull/192's commit messages.
        elem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch (ignored) {
        elem.scrollIntoView(false);
      }
    },
    _canChat() {
      if (!user.isLoggedIn()) return false;
      if (!self.canvasBanRespected) return !self.chatban.banned;
      return !self.chatban.banned && !self.canvasBanned;
    },
    updateCanvasBanState(state) {
      self.canvasBanned = state;
      const canChat = self._canChat();
      self._handleChatbanVisualState(canChat);
      if (!canChat) {
        if (self.elements.rate_limit_counter.text().trim().length === 0) { self.elements.rate_limit_counter.text('You cannot use chat while canvas banned.'); }
      }
    }
  };
  return {
    init: self.init,
    webinit: self.webinit,
    _handleActionClick: self._handleActionClick,
    clearPings: self.clearPings,
    setCharLimit: self.setCharLimit,
    processMessage: self.processMessage,
    saveIgnores: self.saveIgnores,
    reloadIgnores: self.reloadIgnores,
    addIgnore: self.addIgnore,
    removeIgnore: self.removeIgnore,
    getIgnores: self.getIgnores,
    typeahead: self.typeahead,
    updateSelectedNameColor: self.updateSelectedNameColor,
    updateCanvasBanState: self.updateCanvasBanState,
    registerHook: self.registerHook,
    replaceHook: self.replaceHook,
    unregisterHook: self.unregisterHook,
    runLookup: self.runLookup,
    get markdownProcessor() {
      return self.markdownProcessor;
    },
    get canvasBanRespected() {
      return self.canvasBanRespected;
    }
  };
})();

module.exports.chat = chat;
