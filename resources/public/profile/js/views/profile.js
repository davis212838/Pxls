window.DEFAULT_SPECTRUM_OPTIONS = window.DEFAULT_SPECTRUM_OPTIONS || {
  showInput: true,
  clickoutFiresChange: true,
  flat: false,
  allowEmpty: false,
  showAlpha: false,
  disabled: false,
  showPalette: true,
  showPaletteOnly: false,
  preferredFormat: 'hex',
  theme: 'sp-purple',
};

(() => {

  // hook up in-page tab navigation
  // document.querySelectorAll('#tabsTriggers a[data-action]').forEach(x => x.addEventListener('click', handleTabTrigger));
  initInPageTabNavigation(document.location.pathname);

  // ensure our current action is selected
  if (location.search) {
    const _search = location.search.substr(location.search.startsWith('?') ? 1 : 0).split('&').map(x => x.split('='));
    let action = _search.find(x => x[0].toLowerCase().trim() === 'action');
    if (Array.isArray(action) && action[1] != null) {
      Array.from(document.querySelectorAll('.tab-pane.active')).forEach(x => x.classList.remove('active'));
      Array.from(document.querySelectorAll('.list-group-item[data-action].active')).forEach(x => x.classList.remove('active'));
      let elPane = document.querySelector(`.tab-pane[data-tab="${action[1].toLowerCase()}"]`);
      let elAction = document.querySelector(`.list-group-item[data-action="${action[1].toLowerCase()}"]`);
      if (elPane && elAction) {
        elPane.classList.add('active');
        elAction.classList.add('active');
      }
    }
  }

  // hook up global faction actions
  Array.from(document.querySelectorAll('.global-faction-action[data-action]')).forEach(elAction => elAction.addEventListener('click', handleGlobalFactionAction));

  // hook up faction membership actions
  Array.from(document.querySelectorAll('.faction-media[data-faction-id] .faction-action[data-action]')).forEach(elAction => elAction.addEventListener('click', handleFactionAction));
  Array.from(document.querySelectorAll('.member-list-modal[data-faction-id] .member-row[data-member] .faction-subaction[data-action]')).forEach(elAction => elAction.addEventListener('click', handleFactionSubaction));

  // hook up faction search/join interaction
  initFactionSearch();

  // hook up any existing color inputs if available
  if ($ && $.spectrum) {
    if (document.body.dataset.palette)
      DEFAULT_SPECTRUM_OPTIONS.palette = document.body.dataset.palette.trim().split(',');

    $('input[type="color"]').spectrum(DEFAULT_SPECTRUM_OPTIONS);
  }
})();

async function initFactionSearch() {
  const frmSearch = document.getElementById('frmFactionSearch');
  const txtSearch = document.getElementById('txtFactionSearch');
  const btnSearch = document.getElementById('btnFactionSearch');
  const searchTarget = document.getElementById('searchTarget');
  if (frmSearch && txtSearch && btnSearch && searchTarget) {
    frmSearch.addEventListener('submit', async function(e) {
      e.preventDefault();
      const oldHtml = btnSearch.innerHTML;
      btnSearch.innerHTML = `<i class="fas fa-spinner fa-pulse"></i>`;
      btnSearch.disabled = true;
      txtSearch.disabled = true;
      let res;
      try {
        res = await getJSON(`/factions/search?term=${encodeURIComponent(txtSearch.value)}&after=0`);
      } catch (e) {}
      if (res && res.success === true) {
        if (Array.isArray(res.details)) {
          if (res.details.length > 0) {
            searchTarget.innerHTML = ``;
            crel(searchTarget, //TODO the search endpoint supports basic id-based pagination
              res.details.map(x => {
                const btnCollapseToggle = crel('button', {'class': 'btn btn-sm mr-2 btn-info', 'data-action': 'collapse'},
                  crel('i', {'class': 'fas fa-chevron-down'})
                );
                const btnJoin = crel('button', {'class': 'btn btn-sm btn-success ml-1'},
                  crel('i', {'class': 'fas fa-user-plus mr-1'}),
                  'Join'
                );

                const card = crel('div', {'class': 'card collapseable mb-2'},
                  crel('div', {'class': 'card-header d-flex align-items-center'},
                    crel('div', {'class': 'flex-shrink-1'},
                      btnCollapseToggle
                    ),
                    crel('div', {'class': 'd-flex flex-grow-1 justify-content-between align-items-center'},
                      crel('span', {'class': 'faction-name'}, `(ID: ${x.id}) [${x.tag}] ${x.name}, from ${x.owner}`),
                      crel('div', {'class': 'd-inline-block'},
                        btnJoin
                      )
                    )
                  ),
                  crel('div', {'class': 'card-body p-0 body-collapse-target collapse'},
                    crel('div', {'class': 'p-3'},
                      crel('table',
                        crel('tbody',
                          crel('tr',
                            crel('th', {'class': 'text-right pr-3'}, 'ID'),
                            crel('td', {'class': 'text-left'}, x.id)
                          ),
                          crel('tr',
                            crel('th', {'class': 'text-right pr-3'}, 'Name'),
                            crel('td', {'class': 'text-left'}, x.name)
                          ),
                          crel('tr',
                            crel('th', {'class': 'text-right pr-3'}, 'Tag'),
                            crel('td', {'class': 'text-left'}, x.tag)
                          ),
                          crel('tr',
                            crel('th', {'class': 'text-right pr-3'}, 'Owner'),
                            crel('td', {'class': 'text-left'}, crel('a', {'href': `/profile/${x.owner}`, 'target': '_blank'}, x.owner))
                          ),
                          crel('tr',
                            crel('th', {'class': 'text-right pr-3'}, 'Member Count'),
                            crel('td', {'class': 'text-left'}, x.memberCount || -1)
                          ),
                          crel('tr',
                            crel('th', {'class': 'text-right pr-3'}, 'Created Date'),
                            crel('td', {'class': 'text-left'}, new Date(x.creation_ms).toString())
                          ),
                          crel('tr',
                            crel('th', {'class': 'text-right pr-3'}, 'Created Canvas'),
                            crel('td', {'class': 'text-left'}, x.canvasCode)
                          ),
                        )
                      )
                    )
                  )
                );
                btnCollapseToggle.addEventListener('click', function() {
                  handleCollapseIconToggle(card.querySelector('.body-collapse-target'), this.querySelector('.fas'))
                });
                btnJoin.addEventListener('click', async function() {
                  if (await popConfirmDialog('Are you sure you want to join this faction?') === true) {
                    let res;
                    try {
                      res = await putJSON(`/factions/${x.id}`, {joinState: true});
                    } catch (e) {}
                    if (res && res.success === true) {
                      alert('Faction joined. The page will now reload.');
                      document.location.href = document.location.href; //TODO replace with slidein
                    } else {
                      alert((res && res.details) || 'An unknown error occurred. Please try again later.');
                    }
                  }
                });
                return card;
              })
            );
          } else {
            searchTarget.innerHTML = `<p class="text-muted text-center">No results for this search term.</p>`
          }
        }
      } else {
        alert((res && res.details) || 'An unknown error occurred. Please try again later.');
      }
      btnSearch.innerHTML = oldHtml;
      btnSearch.disabled = false;
      txtSearch.disabled = false;
    });
  }
}

async function handleFactionAction() {
  const fmedia = this.closest('.faction-media[data-faction-id]');
  const fid = fmedia.dataset.factionId;
  const action = this.dataset.action.toLowerCase().trim();
  if (!fid) return;
  switch(action) {
    case 'factiondelete': {
      if (await popConfirmDialog('Are you sure you want to delete this faction? This cannot be undone!') === true) {
        let res;
        try {
          res = await deleteJSON(`/factions/${fid}`);
        } catch (e) {}
        if (res && res.success === true) {
          alert('Faction deleted. The page will now reload.');
          document.location.href = document.location.href; //TODO replace with slidein
        } else {
          alert((res && res.details) || 'An unknown error occurred. Please try again later.');
        }
      }
      break;
    }
    case 'factionremovedisplayed': {
      if (await popConfirmDialog('Are you sure you want to remove this from your displayed status? It will no longer show up next to your name in chat.') === true) {
        let res;
        try {
          res = await putJSON(`/factions/${fid}`, {displayed: false});
        } catch (e) {}
        if (res && res.success === true) {
          alert('Status updated. The page will now reload.');
          document.location.href = document.location.href; //TODO replace with slidein
        } else {
          alert((res && res.details) || 'An unknown error occurred. Please try again later.');
        }
      }
      break;
    }
    case 'factionsetdisplayed': {
      if (await popConfirmDialog('Are you sure you want to set this as your displayed status? It will show up next to your name in chat.') === true) {
        let res;
        try {
          res = await putJSON(`/factions/${fid}`, {displayed: true});
        } catch (e) {}
        if (res && res.success === true) {
          alert('Status updated. The page will now reload.');
          document.location.href = document.location.href; //TODO replace with slidein
        } else {
          alert((res && res.details) || 'An unknown error occurred. Please try again later.');
        }
      }
      break;
    }
    case 'factionleave': {
      if (await popConfirmDialog('Are you sure you want to leave this faction? You will have to find it again in the factions list if you want to rejoin.') === true) {
        let res;
        try {
          res = await putJSON(`/factions/${fid}`, {joinState: false});
        } catch (e) {}
        if (res && res.success === true) {
          alert('Faction left. The page will now reload.');
          document.location.href = document.location.href; //TODO replace with slidein
        } else {
          alert((res && res.details) || 'An unknown error occurred. Please try again later.');
        }
      }
      break;
    }
    case 'factionedit': {
      popFactionModal(true, {name: fmedia.dataset.factionName, tag: fmedia.dataset.factionTag, color: fmedia.dataset.factionColor >> 0, fid});
      break;
    }
  }
}

async function handleFactionSubaction() {
  const fid = this.closest('[data-faction-id]').dataset.factionId;
  const action = this.dataset.action.toLowerCase().trim();
  const member = this.closest('[data-member]').dataset.member;
  if (!fid || !action || !member) return;
  switch(action) {
    case 'transfer': {
      if (await popConfirmDialog(`Are you sure you want to transfer ownership? You'll have to ask ${member} to transfer back if you change your mind, and they can say no!`) === true) {
        let res;
        try {
          res = await putJSON(`/factions/${fid}`, {newOwner: member});
        } catch (e) {}
        if (res && res.success === true) {
          alert('Faction updated. The page will now reload.');
          document.location.href = document.location.href; //TODO replace with slidein
        } else {
          alert((res && res.details) || 'An unknown error occurred. Please try again later.');
        }
      }
      break;
    }
    case 'ban': {
      if (await popConfirmDialog(`Are you sure you want to ban ${member}?`) === true) {
        let res;
        try {
          res = await putJSON(`/factions/${fid}`, {user: member, banState: true});
        } catch (e) {}
        if (res && res.success === true) {
          alert('Faction updated. The page will now reload.');
          document.location.href = document.location.href; //TODO replace with slidein
        } else {
          alert((res && res.details) || 'An unknown error occurred. Please try again later.');
        }
      }
      break;
    }
    case 'unban': {
      if (await popConfirmDialog(`Are you sure you want to unban ${member}?`) === true) {
        let res;
        try {
          res = await putJSON(`/factions/${fid}`, {user: member, banState: false});
        } catch (e) {}
        if (res && res.success === true) {
          alert('Faction updated. The page will now reload.');
          document.location.href = document.location.href; //TODO replace with slidein
        } else {
          alert((res && res.details) || 'An unknown error occurred. Please try again later.');
        }
      }
      break;
    }
  }
}

function popFactionModal(isEdit=false,data={}) {
  if (isEdit && data.fid == null) throw new Error('Invalid data supplied to popFactionModal. Missing fid');
  const _nameMax = document.body.dataset.factionMaxName || 99999;
  const _tagMax = document.body.dataset.factionMaxTag || 99999;

  const txtFactionName = crel('input', {'type': 'text', 'autocomplete': 'disabled', 'class': 'form-control', 'maxLength': _nameMax, 'required': 'true', 'value': data.name || ''});
  const txtFactionTag = crel('input', {'type': 'text', 'autocomplete': 'disabled', 'class': 'form-control', 'maxLength': _tagMax, 'required': 'true', 'value': data.tag || ''});
  const txtFactionColor = crel('input', {'type': 'color', 'autocomplete': 'disabled', 'class': 'form-control', 'required': 'true', 'value': isEdit ? intToHex(data.color >> 0) : '#000000'});
  const btnCancel = crel('button', {'class': 'btn btn-secondary ml-1', 'data-dismiss': 'modal', 'type': 'button'}, 'Cancel');
  const btnSave = crel('button', {'class': 'btn btn-primary ml-1', 'type': 'submit'}, isEdit ? 'Update' : 'Create');
  const frmMain = crel('form', {'action': '#', 'method': 'POST'}, // abusing forms for required input checks
    crel('h5', {'class': 'mx-0 mt-0 mb-3'}, 'Faction Details'),
    crel('div', {'class': 'ml-3'},
      crel('div', {'class': 'input-group my-0'},
        crel('div', {'class': 'input-group-prepend'},
          crel('span', {'class': 'input-group-text'}, 'Faction Name:')
        ),
        txtFactionName
      ),
      crel('small', {'class': 'text-muted'}, `The name of your faction will be displayed when your tag is hovered in chat. Maximum of ${_nameMax} characters.`),
      crel('div', {'class': 'input-group mt-3 mb-0'},
        crel('div', {'class': 'input-group-prepend'},
          crel('span', {'class': 'input-group-text'}, 'Faction Tag:')
        ),
        txtFactionTag
      ),
      crel('small', {'class': 'text-muted'}, `Your tag is displayed next to your name in chat. Maximum of ${_tagMax} characters.`),
      crel('div', {'class': 'input-group mt-3 mb-0'},
        crel('div', {'class': 'input-group-prepend'},
          crel('span', {'class': 'input-group-text'}, 'Faction Color:')
        ),
        txtFactionColor
      ),
      crel('small', {'class': 'text-muted'}, `Your faction color changes your tag color in chat.`),
      crel('div', {'class': 'mt-3 text-right'},
        btnCancel,
        btnSave
      )
    )
  );

  if ($.spectrum) {
    $(txtFactionColor).spectrum(DEFAULT_SPECTRUM_OPTIONS);
  }

  frmMain.addEventListener('submit', async function(e) {
    e.preventDefault();
    const oldHtml = btnSave.innerHTML;
    txtFactionName.disabled = true;
    txtFactionTag.disabled = true;
    btnCancel.disabled = true;
    btnSave.disabled = true;
    btnSave.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Working...`;

    try {
      let endpoint = isEdit ? `/factions/${data.fid}` : `/factions`;
      let _toPost = {name: txtFactionName.value, tag: txtFactionTag.value, color: parseInt(txtFactionColor.value.substring(1), 16)};
      let res;
      try {
        res = await (isEdit ? putJSON : postJSON)(endpoint, _toPost);
      } catch (e) {}
      if (res && res.success === true) {
        alert(`Faction ${isEdit ? 'edit' : 'creat'}ed. The page will now reload`);
        document.location.href = document.location.href; //TODO replace with slideins
      } else {
        alert((res && res.details) || `An error ocurred while ${isEdit ? 'edit' : 'creat'}ing the faction. Please try again later.`);
        btnCancel.disabled = false;
        btnSave.innerHTML = `Create`;
      }
    } catch (e) {} finally {
      txtFactionName.disabled = false;
      txtFactionTag.disabled = false;
      btnCancel.disabled = false;
      btnSave.disabled = false;
      btnSave.innerHTML = oldHtml;
    }

  });

  popModal(crel('div', {'class': 'modal', 'tabindex': '-1', 'data-backdrop': 'static', 'data-keyboard': 'false'},
    crel('div', {'class': 'modal-dialog'},
      crel('div', {'class': 'modal-content'},
        crel('div', {'class': 'modal-header'},
          crel('h5', {'class': 'modal-title'}, `${isEdit ? 'Edit' : 'Create'} Faction`)
        ),
        crel('div', {'class': 'modal-body'},
          frmMain
        )
      )
    )
  ), txtFactionName);
}

function handleGlobalFactionAction(e) {
  switch (this.dataset.action.toLowerCase().trim()) {
    case 'factioncreate': {
      popFactionModal();
      break;
    }
    default: {
      console.warn('Unhandled global faction action: %o', this.dataset.action);
      break;
    }
  }
}

function intToHex(int) {
  return `#${('000000' + ((int) >>> 0).toString(16)).slice(-6)}`;
}