import { watch } from 'vue'
import { defineStore } from 'pinia'
import type { ICVMat } from '@/utils/cv'
import { measureLatency, tillChanged } from '@/utils/cv/measurement'
import { toCanvas } from '@/utils/IMat'
import type { IArScannerData } from './../scanner/scanner'
import { getScannerInstance } from '../scanner/scanner.client'
import fastq from 'fastq'
import { setArtifactHash } from '@/views/Artifact/artifactUtil'
import { ICapturer } from '@/components/Capturer/typing'
import delay from 'delay'
const tempCanvas = document.createElement('canvas')
let controller = new AbortController()
export const useArstore = defineStore('artifact-capture-scanner', {
    state: () => {
        controller.abort()
        controller = new AbortController()
        return {
            step: 1,
            capKey: Date.now(),
            scanner: null as ReturnType<typeof getScannerInstance> | null,
            cap: null as ICapturer | null,
            panelRect: {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            centerRect: {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            countRect: {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            blocks: null as { x: number; y: number }[] | null,
            rectx1: 0,
            recty1: 0,
            renderLatancy: 0,
            queue: null as fastq.queue | null,
            results: [] as IArScannerData[],
            resultHashes: [] as string[],
            scanned: 0,
            duplicates: 0,
        }
    },
    getters: {
        resF: (state) => state.results.filter((r) => !r.success),
        resT: (state) => state.results.filter((r) => r.success),
    },
    actions: {
        capture() {
            if (!this.cap) throw new Error('No video')
            return this.cap.capture({ x: 0, y: 0, w: 0, h: 0 })
        },
        capturePanel() {
            if (!this.cap) throw new Error('No video')
            return this.cap.capture({
                x: this.panelRect.x,
                y: this.panelRect.y,
                w: this.panelRect.width,
                h: this.panelRect.height,
            })
        },
        async scrollToNext() {
            if (!this.scanner || !this.cap) throw new Error('No scanner')
            if (this.cap.windowId <= 0) return
            console.log('-> Scroll')
            const image = this.cap.capture({
                x: this.centerRect.x,
                y: this.centerRect.y,
                w: this.rectx1 || this.centerRect.width / 4,
                h: this.recty1 || this.centerRect.height / 2,
            })
            new Image().src = toCanvas(image).toDataURL()
            await delay(30000)
        },
        async switchToNext(prev?: Promise<unknown>) {
            if (!this.scanner || !this.cap) throw new Error('No scanner')
            if (this.cap.windowId <= 0) throw new Error('No window')
            console.log('-> Click')
            let shouldWait = true
            if (this.blocks === null) {
                shouldWait = false
                this.blocks = []
            }
            if (this.blocks.length === 0) {
                // no blocks
                if (shouldWait) {
                    // not first time, so do paging
                    if (prev) await prev
                    await delay(this.renderLatancy / 2 || 40)
                    console.log('->capture')
                    const image = this.capturePanel()
                    this.blocks = null
                    return {
                        image,
                        next: this.scrollToNext(),
                    }
                }
                const image = this.cap.capture({
                    x: this.centerRect.x,
                    y: this.centerRect.y,
                    w: this.centerRect.width,
                    h: this.centerRect.height,
                })
                const b = await this.scanner.workerCV.analyzeBlocks(image)
                const blocks = [] as { x: number; y: number }[]
                for (const y of b.y) {
                    for (const x of b.x) {
                        blocks.push({ x, y })
                    }
                }
                this.rectx1 = b.x[1]
                this.blocks = blocks
            }
            let image: ICVMat | undefined
            if (!this.renderLatancy) {
                const block = this.blocks[2]
                if (!block) throw new Error('No blocks left')
                console.log('-> Latency measurement started')
                const click = this.cap.click
                try {
                    const result = await measureLatency(
                        this.scanner.diffCached.bind(this.scanner),
                        this.capturePanel,
                        async () => {
                            click(this.centerRect.x + block.x, this.centerRect.y + block.y)
                        },
                    )
                    this.renderLatancy = Math.max(120, Math.min(80, result.latency))
                    console.log('-> Latency measurement done:', result)
                    await delay(this.renderLatancy / 2 || 40)
                } catch (e) {
                    console.warn(e)
                    this.renderLatancy = 80
                }
            } else {
                if (prev) await prev
                await delay(this.renderLatancy / 2 || 40)
                console.log('->capture')
                image = this.capturePanel()
            }
            const click = this.cap.click
            const block = this.blocks.shift()
            const next = (async (block) => {
                if (block) {
                    await click(this.centerRect.x + block.x, this.centerRect.y + block.y)
                    await delay(this.renderLatancy / 2 || 40)
                }
            })(block)
            return { image, next }
        },
        async getBlocks() {
            if (!this.cap) throw new Error('No video')
            if (!this.scanner) throw new Error('No scanner')
            const image = this.cap.capture({
                x: this.centerRect.x,
                y: this.centerRect.y,
                w: this.centerRect.width,
                h: this.centerRect.height,
            })
            const b = await this.scanner.workerCV.analyzeBlocks(image)
            const blocks = [] as { x: number; y: number }[]
            for (const y of b.y) {
                for (const x of b.x) {
                    blocks.push({ x, y })
                }
            }
            this.rectx1 = b.x[1]
            this.recty1 = b.y[1]
            this.blocks = blocks
        },
        async getLatency() {
            if (!this.cap) throw new Error('No video')
            if (!this.scanner) throw new Error('No scanner')
            if (!this.blocks) throw new Error('No blocks scanned')
            const block = this.blocks[2]
            if (!block) throw new Error('No blocks left')
            console.log('-> Latency measurement started')
            const click = this.cap.click
            try {
                const result = await measureLatency(
                    this.scanner.diffCached.bind(this.scanner),
                    this.capturePanel,
                    async () => {
                        click(this.centerRect.x + block.x, this.centerRect.y + block.y)
                    },
                )
                this.renderLatancy = Math.max(120, Math.min(80, result.latency))
                console.log('-> Latency measurement done:', result)
            } catch (e) {
                console.warn(e)
                this.renderLatancy = 80
            }
        },
        async switcherLoop() {
            if (!this.cap) throw new Error('No video')
            if (!this.queue) throw new Error('No queue')
            if (!this.scanner) throw new Error('No scanner')
            const scanner = this.scanner
            const queue = this.queue
            while (this.step === 4) {
                if (this.blocks === null) {
                    await this.getBlocks()
                }
                if (!this.renderLatancy) {
                    await this.getLatency()
                }
                let fri = 0
                this.cap.onFrame(async () => {
                    fri++
                    if (fri % 2 == 0) return
                    const image = this.capturePanel()
                    const diff = await scanner.diffCached(image)
                    if (diff > 10) {
                        this.scanned++
                        queue.push({ image, id: this.scanned })
                    }
                })
                let block: { x: number; y: number } | undefined
                while (this.step === 4 && this.blocks && (block = this.blocks.shift())) {
                    await this.cap.click(this.centerRect.x + block.x, this.centerRect.y + block.y)
                    await delay(Math.max(50, this.renderLatancy / 3 || 50))
                }
                if (this.step !== 4) break
                if (this.blocks && this.blocks.length === 0) {
                    await this.scrollToNext()
                }
            }
        },
        async waitForSwitch() {
            if (!this.scanner || !this.cap) throw new Error('No scanner')
            const res = await tillChanged(this.scanner.diffCached.bind(this.scanner), this.capturePanel, {
                interval: 50,
                threhold: 8,
                signal: controller.signal,
                timeout: 5000,
            })
            console.log('->changed', res.result)
            return res.image
        },
        async analyzeUI() {
            if (!this.cap) throw new Error('No video')
            if (!this.scanner) throw new Error('No scanner')
            const image = this.capture()
            const bag = await this.scanner.workerCV.analyzeBag(image)
            this.panelRect = bag.panelRect
            this.centerRect = bag.centerRect
            this.countRect = bag.countRect
            tempCanvas.width = bag.panelRect.width
            tempCanvas.height = bag.panelRect.height
            await Promise.all([this.scanner.workerCV.setCachedBag(bag), this.scanner.workerOCR.setCachedBag(bag)])
            console.log('->analyzeUI', bag)
        },
        async scannerLoop() {
            if (!this.cap) throw new Error('No video')
            if (this.queue) {
                this.queue.killAndDrain()
            }
            this.queue = fastq.promise(store.worker, 1)
            await this.analyzeUI()
            if (this.cap.windowId > 0) {
                return this.switcherLoop()
            }
            let image = this.capturePanel()
            while (this.step === 4) {
                if (image) {
                    this.scanned++
                    this.queue.push({ image, id: this.scanned })
                }
                try {
                    image = await this.waitForSwitch()
                } catch (e) {
                    image = await this.capturePanel()
                }
            }
        },
        async worker({ image, id }: { image: ICVMat | null; id: number }) {
            if (!this.scanner) throw new Error('No scanner')
            if (!this.queue) throw new Error('No queue')
            if (!image) return
            let sid = 1
            let onimg = this.scanner.onScreenShot
            if (this.queue.concurrency === 2 && id % 2 === 0) {
                onimg = this.scanner.onScreenShot2
                sid = 2
            }
            const res = await onimg(image)
            const data = {
                ...res,
                image: toCanvas(image).toDataURL(),
            } as IArScannerData
            if (data.success && data.artifact) {
                const hash = setArtifactHash(data.artifact)
                // find duplicated
                if (this.resultHashes.includes(hash)) {
                    this.duplicates++
                    console.log(`->${sid}dup`, data.artifact)
                } else {
                    console.log(`->${sid}got`, data.artifact)
                    this.results.push(data)
                    this.resultHashes.push(hash)
                }
            } else {
                this.results.push(data)
                console.warn(`->${sid}fail`, data)
                new Image().src = toCanvas(image).toDataURL()
            }
        },
    },
})
const store = useArstore()
watch(
    () => store.step,
    async (step) => {
        if (step === 1) {
            store.cap && store.cap.reset()
        }
        if (step === 4) {
            store.scanner = getScannerInstance()
            store.scannerLoop()
            return
        }
        if (step === 5) {
            store.queue && (store.queue.concurrency = 2)
            console.log('->waiting for queue')
            await store.queue?.push({ image: null, id: -1 })
            console.log('->done')
            store.step = 6
            return
        }
        if (step === 6 && store.cap) {
            // destroy media track
            controller.abort()
            controller = new AbortController()
            store.cap.stop()
            return
        }
    },
)