/*
 * Obsidian Terminal Plugin
 *
 * Joel Eriksson <je@clevcode.org> 2022
 */

import {
    App,
    Plugin,
    Setting,
    ItemView,
    WorkspaceLeaf,
    PluginSettingTab,
    FileSystemAdapter,
} from 'obsidian'

import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { SearchAddon } from 'xterm-addon-search'
import { WebLinksAddon } from 'xterm-addon-web-links'

import { Writable } from 'stream'

import * as child_process from 'child_process'
import * as quote from 'shell-quote'
import * as path from 'path'
import * as fs from 'fs'

import { resourceBlob, resourceHash } from 'resources'

const decompress = require('decompress')
const decompressTargz = require('decompress-targz')

const TERMINAL_VIEW_TYPE = 'terminal'
const TERMEDIT_VIEW_TYPE = 'termedit'

// Icon names are from lucide.dev
const TERMINAL_ICON = 'terminal'
const TERMEDIT_ICON = 'edit-3'

interface TerminalPluginSettings {
    editor: string
    font: string
    hideTabGroupHeader: boolean
    hideStatusBar: boolean
}

const DEFAULT_SETTINGS: TerminalPluginSettings = {
    editor: '/usr/bin/nvim +":set showtabline=0"',
    font: 'Roboto Mono Nerd Font',
    hideTabGroupHeader: true,
    hideStatusBar: false
}

async function extractTarGz(base64TarGz: string, destinationPath: string) {
    const tarGzBuffer = Buffer.from(base64TarGz, 'base64')
    await decompress(tarGzBuffer, destinationPath, { plugins: [decompressTargz()] })
}

export default class TerminalPlugin extends Plugin {
    settings: TerminalPluginSettings
    vaultPath: string
    manifestPath: string

    async openTerminal() {
        const leaf = this.app.workspace.getLeaf('split', 'horizontal')
        await leaf.setViewState({ type: TERMINAL_VIEW_TYPE, active: true })
        this.app.workspace.revealLeaf(leaf)
        this.app.workspace.setActiveLeaf(leaf, { focus: true })
    }

    async openEditor() {
        const leaf = this.app.workspace.getLeaf('split', 'horizontal')
        await leaf.setViewState({ type: TERMEDIT_VIEW_TYPE, active: true })
        this.app.workspace.revealLeaf(leaf)
        this.app.workspace.setActiveLeaf(leaf, { focus: true })
    }

    async onload() {
        await this.loadSettings()

        const adapter = this.app.vault.adapter
        if (! (adapter instanceof FileSystemAdapter))
            throw new Error('This plugin requires a FileSystemAdapter for now')
        this.vaultPath = adapter.getBasePath()

        const manifestPath = this.manifest.dir
        if (manifestPath == null)
            throw new Error('Could not determine manifest directory')
        this.manifestPath = manifestPath

        let resourcesUnpacked: boolean = false
        try {
            // Extract resources if they are not already extracted
            const data = fs.readFileSync(
                path.join(
                    this.vaultPath,
                    this.manifestPath,
                    'resources',
                    'CHECKSUM'
                ), 'utf8'
            );
            const checksum = data.trim();
            if (checksum == resourceHash)
                resourcesUnpacked = true
        } catch { }
        if (! resourcesUnpacked)
            await extractTarGz(resourceBlob, path.join(this.vaultPath, this.manifestPath))

        const fontPath = path.join(manifestPath, 'resources', 'Roboto Mono Nerd Font Complete.ttf')
        const fontURL = app.vault.adapter.getResourcePath(fontPath)
        const robotoMono = new FontFace('Roboto Mono Nerd Font', `url(${fontURL})`)
        await robotoMono.load()
        // @ts-ignore
        document.fonts.add(robotoMono)

        this.registerView(TERMINAL_VIEW_TYPE, leaf => new TerminalView(leaf, this))
        this.registerView(TERMEDIT_VIEW_TYPE, leaf => new EditorView(leaf, this))
        this.addSettingTab(new TerminalSettingTab(this.app, this))

        if (this.settings.hideStatusBar)
            // @ts-ignore
            document.querySelector('div[class="status-bar"]').style.display = 'none'

        this.addCommand({
            id: 'open-terminal',
            name: 'Open Terminal',
            callback: () => this.openTerminal()
        })
        this.addCommand({
            id: 'open-terminal-editor',
            name: 'Edit file in Terminal editor',
            callback: () => this.openEditor()
        })
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
    }

    async saveSettings() {
        await this.saveData(this.settings)
        if (this.settings.hideStatusBar)
            // @ts-ignore
            document.querySelector('div[class="status-bar"]').style.display = 'none'
        else
            // @ts-ignore
            document.querySelector('div[class="status-bar"]').style.display = ''
    }
}

class TerminalViewHelper {
    ptyHelper: child_process.ChildProcess
    plugin: TerminalPlugin
    contentEl: HTMLElement
    term: Terminal | null
    fitAddon: FitAddon
    app: App
    cwd: string
    cmd: string[]
    cssURL: string
    fontURL: string
    stdin: Writable
    helperPath: string
    timer: number = 0
    itemView: ItemView
    handleKey: Function

    constructor(app: App, contentEl: HTMLElement, itemView: ItemView, plugin: TerminalPlugin) {
        this.app = app
        this.plugin = plugin
        this.itemView = itemView
        this.contentEl = contentEl

        this.helperPath = path.join(this.plugin.vaultPath, this.plugin.manifestPath, 'resources', 'pty-helper.py')

        this.cmd = []
        this.cwd = this.plugin.vaultPath

        const cssPath = path.join(this.plugin.manifestPath, 'resources', 'xterm.css')
        this.cssURL = app.vault.adapter.getResourcePath(cssPath)

        this.term = null
    }

    async onOpen() {
        const iframe = document.createElement('iframe')
        this.contentEl.appendChild(iframe)
        const html = `
            <!doctype html>
            <html>
             <head>
              <link rel="stylesheet" href="${this.cssURL}" />
              <style>
               html, body { overflow: hidden; height: 100vh; width: 100vw; margin: 0 }
               #terminal { height: 100vh; width: 100vw; margin: 0 }
              </style>
             </head>
             <body>
              <div id="terminal"></div>
             </body>
            </html>
        `
        const blob = new Blob([html], {type: 'text/html'})
        iframe.src = window.URL.createObjectURL(blob)
        iframe.setAttribute('style', 'width: 100%; height: 100%; margin: 0')
        iframe.onload = async () => {
            if (iframe.contentDocument == null)
                throw new Error('iframe.contentDocument is null')
            // @ts-ignore
            for (const font of document.fonts.values()) {
                // @ts-ignore
                iframe.contentDocument.fonts.add(font)
            }
            this.openTerm(iframe.contentDocument)
        }
        this.contentEl.innerHTML = ''
        this.contentEl.setAttribute
        this.contentEl.appendChild(iframe)

        this.showTabGroupHeader(! this.plugin.settings.hideTabGroupHeader)
        this.showNavigation(false)
    }

    showTabGroupHeader(show: boolean) {
        // @ts-ignore
        const element = this.itemView.containerEl.parentElement?.parentElement?.previousSibling
        // @ts-ignore
        element.style.display = show ? '' : 'none'
    }

    showNavigation(show: boolean) {
        // @ts-ignore
        this.contentEl.previousSibling.querySelector('div[class="view-header-nav-buttons"]').style.display = show ? '' : 'none'
    }

    openTerm(contentDocument: Document) {
        const backgroundColor = getComputedStyle(this.contentEl).getPropertyValue('--background-primary')

        this.contentEl.setAttribute('style', `
           contain: strict;
           overflow: hidden;
        `);

        const term = this.term = new Terminal({
          allowProposedApi: true,
          fontFamily: this.plugin.settings.font,
          theme: { background: backgroundColor },
        })

        this.fitAddon = new FitAddon()
        const searchAddon = new SearchAddon()
        const weblinksAddon = new WebLinksAddon()

        const el = contentDocument.getElementById('terminal')
        if (el == null)
            throw Error('iframe #terminal not found')

        term.open(el)
        term.loadAddon(this.fitAddon)
        term.loadAddon(searchAddon)
        term.loadAddon(weblinksAddon)

        let ptyHelper = child_process.spawn(this.helperPath, this.cmd, {
            cwd: this.cwd,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
            windowsHide: true
        })

        ptyHelper.stdout.on('data', data => term.write(data))
        ptyHelper.stderr.on('data', data => term.write(data))
        ptyHelper.stdin.on('close', async () => {
            ptyHelper.kill()
            this.itemView.leaf.detach()
        })

        term.onData((data) => {
            // HACK: Switch focus to tab group above on ALT-ESC
            if (data == '\x1b\x1b') {
                // @ts-ignore
                this.app.commands.executeCommandById('editor:focus-top')
            } else {
                if (! this.handleKey(data))
                    ptyHelper.stdin.write(data)
            }
        })

        this.ptyHelper = ptyHelper
        this.stdin = this.stdin
        this.resize()

        // HACK: Regain focus on terminal when the tab group is activated
        const tabContainer = this.itemView.containerEl.parentElement
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                // @ts-ignore
                const classes = mutation.target.getAttribute('class').split(' ')
                if (classes.indexOf('mod-active') != -1) {
                    //this.showTabGroupHeader(false)
                    term.focus()
                } else {
                    //this.showTabGroupHeader(true)
                }
            })
        })
        // @ts-ignore
        observer.observe(tabContainer, { attributes: true, attributeFilter: ['class'] })

        term.focus()
    }

    async onClose() {
        this.ptyHelper.kill()
        this.term?.dispose()
    }

    async onResize() {
        if (this.term == null)
            return
        if (this.timer)
            clearTimeout(this.timer)
        this.timer = window.setTimeout(() => this.resize(), 100)
    }

    resize() {
        if (this.term == null)
            return
        this.fitAddon.fit()
        const pipe = this.ptyHelper.stdio[3] as Writable
        pipe.write(new Uint8Array(new Uint16Array([this.term.rows, this.term.cols, 0, 0]).buffer))
    }

    write(buf: string) {
        this.stdin.write(buf)
    }
}

class EditorView extends ItemView {
    plugin: TerminalPlugin
    terminal: TerminalViewHelper
    displayText: string
    filePath: string | null

    constructor(leaf: WorkspaceLeaf, plugin: TerminalPlugin) {
        super(leaf)

        this.plugin = plugin
        this.terminal = new TerminalViewHelper(this.app, this.contentEl, this, plugin)
        this.terminal.handleKey = this.handleKey.bind(this)
        this.displayText = 'Editor'

        const file = this.app.workspace.getActiveFile()
        if (file == null)
            this.filePath = null
        else {
            this.filePath = path.join(this.plugin.vaultPath, file.path)
            this.displayText = file.basename
        }
    }

    handleKey(data: string): boolean {
        if (data == '\x1a')
            return true // Ignore CTRL-Z
        return false
    }

    getIcon() { return TERMEDIT_ICON }
    getViewType() { return TERMEDIT_VIEW_TYPE }
    getDisplayText() { return this.displayText }

    async onOpen() {
        this.terminal.cmd = quote.parse(this.plugin.settings.editor).map(x => x.toString())
        if (this.filePath != null) {
            this.terminal.cmd.push(this.filePath)
            this.terminal.cwd = path.dirname(this.filePath)
        }
        await this.terminal.onOpen()
    }

    async onClose() {
        await this.terminal.onClose()
    }

    async onResize() {
        await this.terminal.onResize()
    }
}

class TerminalView extends ItemView {
    plugin: TerminalPlugin
    terminal: TerminalViewHelper
    displayText: string
    filePath: string | null

    constructor(leaf: WorkspaceLeaf, plugin: TerminalPlugin) {
        super(leaf)

        this.plugin = plugin
        this.terminal = new TerminalViewHelper(this.app, this.contentEl, this, plugin)
        this.terminal.handleKey = this.handleKey.bind(this)
        this.displayText = 'Terminal'

        const file = this.app.workspace.getActiveFile()

        if (file == null)
            this.filePath = null
        else
            this.filePath = path.join(this.plugin.vaultPath, file.path)

        // FIXME: Make it possible to request cwd through fd 3, and use it for displayText
        // Can readlink on /proc/PID/cwd to get cwd of child process
    }

    handleKey(_: string): boolean {
        //const hexdump = Array.from(data).map(c => c.charCodeAt(0).toString(16)).join('')
        return false
    }

    getIcon() { return TERMINAL_ICON }
    getViewType() { return TERMINAL_VIEW_TYPE }
    getDisplayText() { return this.displayText }

    async onOpen() {
        if (this.filePath != null)
            this.terminal.cwd = path.dirname(this.filePath)
        await this.terminal.onOpen()
    }

    async onClose() {
        await this.terminal.onClose()
    }

    async onResize() {
        await this.terminal.onResize()
    }
}

class TerminalSettingTab extends PluginSettingTab {
    plugin: TerminalPlugin

    constructor(app: App, plugin: TerminalPlugin) {
        super(app, plugin)
        this.plugin = plugin
    }

    display(): void {
        const {containerEl} = this

        containerEl.empty()
        containerEl.createEl('h2', {text: 'Settings for Terminal plugin'})

        new Setting(containerEl)
            .setName('Editor')
            .setDesc('Path to your editor, and any arguments to be passed before the filename')
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.editor)
                .setValue(this.plugin.settings.editor)
                .onChange(async (value) => {
                    this.plugin.settings.editor = value
                    await this.plugin.saveSettings()
                }))

        new Setting(containerEl)
            .setName('Font')
            .setDesc('Name of the Terminal font to use')
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.font)
                .setValue(this.plugin.settings.font)
                .onChange(async (value) => {
                    this.plugin.settings.font = value
                    await this.plugin.saveSettings()
                }))

        new Setting(containerEl)
            .setName('Hide header')
            .setDesc('Hide the tab group header')
            .addToggle(enabled => enabled 
                .setValue(this.plugin.settings.hideTabGroupHeader)
                .onChange(async (value) => {
                    this.plugin.settings.hideTabGroupHeader = value
                    await this.plugin.saveSettings()
                }))

        new Setting(containerEl)
            .setName('Hide status bar')
            .setDesc('Hide the global status bar')
            .addToggle(enabled => enabled 
                .setValue(this.plugin.settings.hideStatusBar)
                .onChange(async (value) => {
                    this.plugin.settings.hideStatusBar = value
                    await this.plugin.saveSettings()
                }))
    }
}
