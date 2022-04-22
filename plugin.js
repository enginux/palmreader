/* eslint-disable new-cap */
/* eslint-disable brace-style */
/* eslint-disable  max-statements-per-line */

'use strict';

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const State = require('./lib/state');
const {Rules, Namestate} = require('hsd');

const Logger = require('./lib/widgets/logger');
const NodeStatus = require('./lib/widgets/nodeStatus');
const WalletList = require('./lib/widgets/walletList');
const AccountList = require('./lib/widgets/accountList');
const AccountDetails = require('./lib/widgets/accountDetails');
const CreateWallet = require('./lib/widgets/createWallet');
const BackupWallet = require('./lib/widgets/backupWallet');
const CreateTransaction = require('./lib/widgets/createTransaction');
const ImportTransaction = require('./lib/widgets/importTransaction');
const Names = require('./lib/widgets/names');
const Actions = require('./lib/widgets/actions');

const SignTransaction = require('./lib/modals/signTransaction');
const ExportTransaction = require('./lib/modals/exportTransaction');
const UpdateRecords = require('./lib/modals/updateRecords');

class App {
  constructor(node) {
    this.node = node;
    this.walletdb = null;
    this.wdb = null;
    this.walletLoaded = false;

    this.state = new State();

    this.screen = blessed.screen();

    // Covers up a bug in blessed where fragments of "hidden" objects
    // still appear between the cracks of other visible objects.
    // This is just a big black curtain that hangs behind the grid
    // and will be redrawn to cover up those fragments when screen is rendered.
    this.box = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      bg: 'black'
    });

    // Main dashboard is a 12x12 grid.
    // TODO: this can be expanded to multiple "pages" using contrib.carousel
    this.grid = new contrib.grid({rows: 12, cols: 12, screen: this.screen});

    // Create and add widgets to grid
    // coords = [row, col, rowSpan, colSpan]
    this.logger = new Logger({
      app: this,
      coords: [0, 0, 6, 6]
    });
    this.names = new Names({
      app: this,
      coords: [6, 0, 6, 3],
      focusKeys: ['n', 'N']
    });
    this.actions = new Actions({
      app: this,
      coords: [6, 3, 6, 3],
      focusKeys: ['x', 'X']
    });
    this.nodeStatus = new NodeStatus({
      app: this,
      coords: [0, 6, 2, 6]
    });
    this.walletList = new WalletList({
      app: this,
      coords: [2, 6, 2, 3],
      focusKeys: ['w', 'W']
    });
    this.accountList = new AccountList({
      app: this,
      coords: [2, 9, 2, 3],
      focusKeys: ['a', 'A']
    });
    this.accountDetails = new AccountDetails({
      app: this,
      coords: [4, 6, 3, 6],
      focusKeys: ['d', 'D']
    });
    this.createWallet = new CreateWallet({
      app: this,
      coords: [7, 6, 2, 3],
      focusKeys: ['c', 'C']
    });
    this.backupWallet = new BackupWallet({
      app: this,
      coords: [7, 9, 2, 3],
      focusKeys: ['b', 'B']
    });
    this.createTransaction = new CreateTransaction({
      app: this,
      coords: [9, 6, 3, 3],
      focusKeys: ['t', 'T']
    });
    this.importTransaction = new ImportTransaction({
      app: this,
      coords: [9, 9, 3, 3],
      focusKeys: ['i', 'I']
    });

    // Store all widgets in array for refresh loops
    this.refreshRate = 250;
    this.widgets = [
      this.logger,
      this.names,
      this.actions,
      this.nodeStatus,
      this.walletList,
      this.accountList,
      this.accountDetails,
      this.createWallet,
      this.backupWallet,
      this.createTransaction
    ];

    // Create and add modals directly to sreen
    this.signTransaction = new SignTransaction({
      app: this
    });
    this.exportTransaction = new ExportTransaction({
      app: this
    });
    this.updateRecords = new UpdateRecords({
      app: this
    });

    // Store all modals for refresh loops
    this.modals = [
      this.signTransaction,
      this.exportTransaction,
      this.updateRecords
    ];
  }

  async open() {
    setInterval(
      async () => {
        // Keep retrying wallet on boot until it is ready
        if (!this.walletLoaded)
          await this.loadWallet();

        // Update display every frame
        this.refreshAll();
      },
      this.refreshRate
    );

    // Bind to node events
    this.node.chain.on('connect', async () => {
      await this.loadWallet();
      await this.getSelectedWalletNames();
      await this.selectName(this.state.selectedName);
      this.refreshAll();
    });

    // Global keys
    this.screen.key(['q', 'Q', 'C-c'], async (ch, key) => {
      await this.node.close();
      // Watch node close in debug log...
      await new Promise(r => setTimeout(r, 500));
      return process.exit(0);
    });

    this.screen.render();
  }

  refreshAll() {
    this.widgets.forEach(widget => widget.refresh());
    // TODO: do modals need to be refreshed 4x a second?!
    this.screen.render();
  }

  isModalOpen() {
    for (const modal of this.modals) {
      if (!modal.box.hidden) {
        return true;
      }
    }
    return false;
  }

  async loadWallet() {
    // Get the wallet plugin from the node, if it's loaded yet
    if (!this.node.has('walletdb'))
      return;

    // Globalize the wallet plugin if we haven't already
    if (!this.walletdb || !this.wdb) {
      this.walletdb = this.node.get('walletdb');
      this.wdb = this.walletdb.wdb;
    }

    // Load all wallet details into global state
    const wids = await this.wdb.getWallets();
    this.state.wallets = {};
    const wallets = this.state.wallets;
    for (const wid of wids) {
      const wallet = await this.wdb.get(wid);
      wallets[wid] = {};
      wallets[wid]['wallet'] = wallet;
      wallets[wid]['accounts'] = [];

      const aids = await wallet.getAccounts();
      for (const aid of aids) {
        const account = await wallet.getAccount(aid);
        const balance = await wallet.getBalance(account.accountIndex);
        wallets[wid]['accounts'][aid] = {};
        wallets[wid]['accounts'][aid]['account'] = account;
        wallets[wid]['accounts'][aid]['info']= account.getJSON(balance);
      }
    }
    this.state.walletPath = this.wdb.options.location;
    this.state.feeRate = await this.wdb.estimateFee(1);

    // Only do this stuff once
    if (!this.walletLoaded) {
      // Bind to wallet events
      this.wdb.once('balance', async () => {
        try {
          await this.loadWallet();
          await this.refreshAll();
        } catch (e) {
          this.log(e.message);
        }
      });

      // Bind events on all wallet widgets
      this.widgets.forEach(widget => widget.initWallet());

      // Load primary/default
      await this.selectWallet('primary');

      this.walletLoaded = true;
    }
  }

  async selectWallet(wid) {
    if (this.state.selectedWallet === wid)
      return;

    this.state.selectedWallet = wid;
    // All wallets have default account
    this.state.selectedAccount = 'default';
    // Equivalent to `hsw-rpc selectwallet ...`
    const wallet = this.state.getWallet();
    this.walletdb.rpc.wallet = wallet;

    await this.getSelectedWalletNames();
    await this.selectName(null);
  }

  async getSelectedWalletNames() {
    const wallet = this.state.getWallet();
    const names = await wallet.getNames();

    let {height, network} = this.node.chain;
    height++;

    const out = [];
    for (const ns of names) {
      const json = ns.getJSON(height, network);
      this.state.namesByHash.set(json.nameHash, json.name);

      json.reserved = Rules.isReserved(ns.nameHash, height, network);
      // Note: `expired` will override the actual property from NameState,
      // but it's confusing and only has to do with claimable names...
      json.expired = ns.isExpired(height, network);

      // TODO: check auction state before claiming ownership
      const {hash, index} = ns.owner;
      const coin = await wallet.getCoin(hash, index);
      json.own = Boolean(coin);

      json.bids = await wallet.getBidsByName(ns.name);
      json.reveals = await wallet.getRevealsByName(ns.name);

      for (const reveal of json.reveals) {
        if (!reveal.own)
          continue;

        // We can use the wallet's TX index to link our own bids
        // and reveals, but we can not link other users' bids and
        // reveals without the full node TX index.
        // See https://github.com/handshake-org/hsd/issues/716
        const {hash, index} = reveal.prevout;
        const {tx} = await wallet.getTX(hash);
        const input = tx.inputs[index];
        reveal.bid = input.prevout;

        // Check if reveal is spent (needs redeem / register)
        const coin = await wallet.getCoin(hash, index);
        reveal.unspent = Boolean(coin);
      }

      out.push(json);
    }
    this.state.names = out;
  }

  async selectName(name) {
    this.state.selectedName = name || '';

    if (this.actions)
      this.actions.inputName.value = name || '';

    // Reset
    if (!name) {
      this.state.selectedNameState = null;
      return;
    }

    let {height, network} = this.node.chain;
    height++;

    for (const json of this.state.names) {
      if (json.name === name) {
        json.inWallet = true;
        this.state.selectedNameState = json;
        return;
      }
    }

    // Name is not in wallet, check node
    const nameHash = Rules.hashName(name);
    let ns;
    if (this.node.chain.options.spv) {
      const data = await this.node.pool.resolve(nameHash);
      if (data)
        ns = Namestate.decode(data);
    } else {
      ns = await this.node.chain.db.getNameState(nameHash);
    }

    if (ns) {
      const json = ns.getJSON(height, network);
      json.inWallet = false;
      json.reserved = Rules.isReserved(nameHash, height, network);
      json.expired = ns.isExpired(height, network);
      this.state.selectedNameState = json;
    } else {
      // Still can't find name, be opened or claimed
      this.state.selectedNameState = {
        name,
        inWallet: false,
        state: 'NONE',
        reserved: Rules.isReserved(nameHash, height, network),
        expired: false,
        stats: {}
      };
    }
  }

  log(msg) {
    if (!this.logger)
      return;

    this.logger.log(msg);
  }

  async signTX(mtx) {
    if (!this.signTransaction)
      return;

    const wallet = this.state.getWallet();

    // Get input coins to derive our known paths
    const view = await wallet.getCoinView(mtx);
    mtx.view = await wallet.getWalletCoinView(mtx, view);

    // hsd wallet doesn't add path details to outputs... should it?
    for (const output of mtx.outputs) {
      const {address} = output;
      output.path = await wallet.getPath(address);
    }

    this.state.mtx = mtx;
    this.signTransaction.open();
  }

  exportTX(mtx) {
    if (!this.exportTransaction)
      return;

    this.state.hex = mtx.toHex();
    this.exportTransaction.open();
  }

  createUpdate() {
    if (!this.updateRecords)
      return;

    this.updateRecords.open();
  }
}

exports.id = 'palmreader';
exports.init = function init(node) {
  return new App(node);
};
