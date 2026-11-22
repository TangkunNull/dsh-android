#!/usr/bin/env node
/**
 * 探路矩阵：对真实 dsh Host 逐条验证协议假设，输出 PASS/FAIL。
 *
 * 与 probe-gateway.mjs 的分工：那个是「手动探一条」，这个是「一次跑完一组断言」，
 * 拿来做协议回归 —— 改 client 代码前后各跑一遍，接口形状变了会当场红。
 *
 * 用法：
 *   node tools/probe-suite.mjs --token <launch-token>
 *   node tools/probe-suite.mjs --url http://127.0.0.1:3080 --token <t> --verbose
 *
 * 前置：本机已跑起 `dsh web`（Node ≥ 24，见 docs/node-version.md），
 * 并从它的启动输出里拿到 `/?token=` 后面的 launch token。
 *
 * 前置知识（全部为本文件断言的来源，2026-11-18 实测）：
 *   - 认证只有一条路：GET /?token= → 303 + Set-Cookie: dsh-auth-<hash>=…；
 *     之后带这条 cookie。Bearer / x-dsh-token 不认。
 *   - unary 方法：POST /api/<ns>/<method>，body {type:'client-request',rpcId,method,payload:{args}}
 *     endpoint 分隔符是斜杠；用点号（/api/session.list）会被解析拒掉 → 404。
 *   - stream 方法：WS /api/remote.mux，帧 {type:'open',streamId,endpoint,payload}。
 *   - args 的 key 是方法形参名（`_request` / `request` / 无）。
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
	const out = { url: 'http://127.0.0.1:3080', token: '', verbose: false, timeoutMs: 15000 }
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i]
		const next = () => {
			const value = argv[++i]
			if (value === undefined) throw new Error(`missing value for ${key}`)
			return value
		}
		switch (key) {
			case '--url': out.url = next(); break
			case '--token': out.token = next(); break
			case '--verbose': out.verbose = true; break
			case '--timeout': out.timeoutMs = Number(next()); break
			default: throw new Error(`unknown argument ${key}`)
		}
	}
	return out
}

// ------------------------------------------------------------------ 传输 ----

async function exchangeToken(baseUrl, token) {
	const url = new URL('/', baseUrl)
	url.searchParams.set('token', token)
	const response = await fetch(url, { redirect: 'manual' })
	const setCookie = response.headers.getSetCookie?.() ?? []
	const auth = setCookie.find((line) => line.startsWith('dsh-auth-'))
	return { status: response.status, cookie: auth?.split(';', 1)[0] ?? '' }
}

/** 原始 POST，不抛 HTTP 错，交给调用方断言状态码。 */
async function post(baseUrl, cookie, endpoint, payload, timeoutMs) {
	const headers = { 'content-type': 'application/json' }
	if (cookie !== '') headers.cookie = cookie
	const response = await fetch(new URL(`/api/${endpoint}`, baseUrl), {
		method: 'POST',
		headers,
		body: JSON.stringify({ type: 'client-request', rpcId: `suite-${Date.now()}`, method: endpoint, payload }),
		signal: AbortSignal.timeout(timeoutMs),
	})
	const text = await response.text()
	let json
	try {
		json = JSON.parse(text)
	} catch {
		json = undefined
	}
	return { status: response.status, text, json }
}

/** 断言 ok:true 并返回 value；否则抛出可用于展示的失败原因。 */
async function callOk(baseUrl, cookie, endpoint, payload, timeoutMs) {
	const res = await post(baseUrl, cookie, endpoint, payload, timeoutMs)
	if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`)
	const result = res.json?.result
	if (result?.ok !== true) {
		throw new Error(`${result?.error?.code ?? 'unknown'}: ${result?.error?.message ?? res.text.slice(0, 200)}`)
	}
	return result.value
}

function openMux(baseUrl, cookie) {
	const { WebSocket } = require('ws')
	const url = new URL('/api/remote.mux', baseUrl)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	return new WebSocket(url, { headers: { cookie } })
}

/** 读一条流的头 N 帧；长驻流不会 end，所以按帧数收口。 */
function readStream(baseUrl, cookie, endpoint, payload, frames, timeoutMs) {
	const socket = openMux(baseUrl, cookie)
	const streamId = `suite-${Date.now()}`
	return new Promise((resolve, reject) => {
		const received = []
		const timer = setTimeout(() => {
			cleanup()
			if (received.length >= frames) resolve(received)
			else reject(new Error(`stream ${endpoint} timed out: ${received.length}/${frames} frames`))
		}, timeoutMs)
		function cleanup() {
			clearTimeout(timer)
			socket.off('message', onMessage)
			socket.off('error', onError)
			socket.off('close', onClose)
			try {
				socket.close()
			} catch {
				/* 已关闭 */
			}
		}
		function onMessage(data) {
			let frame
			try {
				frame = JSON.parse(String(data))
			} catch {
				return
			}
			if (frame.streamId !== streamId) return
			if (frame.type === 'error') {
				cleanup()
				reject(new Error(`remote error ${frame.error?.code}: ${frame.error?.message}`))
				return
			}
			received.push(frame)
			if (frame.type === 'end' || received.length >= frames) {
				cleanup()
				resolve(received)
			}
		}
		function onError(error) {
			cleanup()
			reject(error)
		}
		function onClose() {
			cleanup()
			if (received.length >= frames) resolve(received)
			else reject(new Error(`socket closed after ${received.length}/${frames} frames`))
		}
		socket.on('message', onMessage)
		socket.on('error', onError)
		socket.on('close', onClose)
		socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload })))
		socket.on('unexpected-response', (_req, res) => {
			cleanup()
			reject(new Error(`WS upgrade rejected: HTTP ${res.statusCode}`))
		})
	})
}

// ------------------------------------------------------------------ 断言 ----

/** 极简断言器：只报路径，不打印整个对象。 */
function expect(condition, message) {
	if (!condition) throw new Error(message)
}

function expectKeys(object, keys, label) {
	for (const key of keys) {
		expect(object !== null && typeof object === 'object' && key in object, `${label} 缺少字段 "${key}"`)
	}
}

// -------------------------------------------------------------------- 用例 ----

async function run({ url, token, timeoutMs, verbose }, state) {
	const results = []
	const record = async (name, body) => {
		const started = Date.now()
		try {
			const detail = await body()
			results.push({ name, ok: true, ms: Date.now() - started, detail })
		} catch (error) {
			results.push({ name, ok: false, ms: Date.now() - started, detail: error.message })
		}
	}

	await record('无 token 访问 / 不签发 cookie', async () => {
		const response = await fetch(new URL('/', url), { redirect: 'manual' })
		const setCookie = response.headers.getSetCookie?.() ?? []
		// 首页本身是 200；关键是没有 dsh-auth cookie 时 /api 会 401。
		const probe = await post(url, '', 'session/list', { args: { _request: {} } }, timeoutMs)
		expect(probe.status === 401, `无 cookie 的 /api 请求应 401，实际 ${probe.status}`)
		return `首页 ${response.status}，无 cookie POST /api → 401`
	})

	await record('token 换 cookie（303 + dsh-auth-*）', async () => {
		const auth = await exchangeToken(url, token)
		expect(auth.status === 303, `期望 303，实际 ${auth.status}`)
		expect(auth.cookie.startsWith('dsh-auth-'), `cookie 名前缀不对: ${auth.cookie.slice(0, 24)}`)
		state.cookie = auth.cookie
		return auth.cookie.split('=')[0]
	})

	await record('反证：endpoint 用点号 → 404', async () => {
		const res = await post(url, state.cookie, 'session.list', { args: { _request: {} } }, timeoutMs)
		expect(res.status === 404, `点号 endpoint 应 404，实际 ${res.status}`)
		return '404 not found（符合预期：endpoint 必须是斜杠分隔）'
	})

	await record('session/list → items[]', async () => {
		const value = await callOk(url, state.cookie, 'session/list', { args: { _request: {} } }, timeoutMs)
		expectKeys(value, ['items'], 'session/list')
		expect(Array.isArray(value.items), 'items 不是数组')
		return `items=${value.items.length}`
	})

	await record('session/modelCatalog → default/routableProviders/groups/failures', async () => {
		const value = await callOk(url, state.cookie, 'session/modelCatalog', { args: {} }, timeoutMs)
		expectKeys(value, ['default', 'routableProviders', 'groups', 'failures'], 'session/modelCatalog')
		return `default=${value.default?.provider}/${value.default?.model} routable=${value.routableProviders.length}`
	})

	await record('session/canOpenWorkspacePath → boolean', async () => {
		const value = await callOk(url, state.cookie, 'session/canOpenWorkspacePath', { args: {} }, timeoutMs)
		expect(typeof value === 'boolean', `应为 boolean，实际 ${typeof value}`)
		return String(value)
	})

	await record('session/create → sessionId/agentPreset', async () => {
		const value = await callOk(url, state.cookie, 'session/create', { args: { request: { cwd: '/tmp' } } }, timeoutMs)
		expectKeys(value, ['sessionId', 'agentPreset'], 'session/create')
		expect(value.sessionId.startsWith('session-'), `sessionId 前缀异常: ${value.sessionId}`)
		state.sessionId = value.sessionId
		return `${value.sessionId} preset=${value.agentPreset}`
	})

	await record('session/state → cursor/active/running', async () => {
		const value = await callOk(url, state.cookie, 'session/state', {
			args: { request: { sessionId: state.sessionId } },
		}, timeoutMs)
		expectKeys(value, ['cursor', 'active', 'running', 'queue', 'pendingInput'], 'session/state')
		return `cursor=${value.cursor} active=${value.active} running=${value.running}`
	})

	await record('session/rename → title/seq', async () => {
		const value = await callOk(url, state.cookie, 'session/rename', {
			args: { request: { sessionId: state.sessionId, title: 'probe suite' } },
		}, timeoutMs)
		expectKeys(value, ['title', 'seq'], 'session/rename')
		expect(value.title === 'probe suite', `title 回显不符: ${value.title}`)
		return `seq=${value.seq}`
	})

	await record('session/page → records/cursor', async () => {
		const value = await callOk(url, state.cookie, 'session/page', {
			args: { request: { address: { kind: 'session', sessionId: state.sessionId } } },
		}, timeoutMs)
		expectKeys(value, ['records', 'cursor'], 'session/page')
		expect(Array.isArray(value.records), 'records 不是数组')
		return `records=${value.records.length} cursor=${value.cursor}`
	})

	await record('WS session/observeState → state 帧', async () => {
		const frames = await readStream(url, state.cookie, 'session/observeState', {
			args: { request: { sessionId: state.sessionId } },
		}, 1, timeoutMs)
		expect(frames[0]?.type === 'item', `首帧应为 item，实际 ${frames[0]?.type}`)
		expectKeys(frames[0].value, ['cursor', 'running'], 'observeState item')
		return `cursor=${frames[0].value.cursor}`
	})

	await record('WS session/follow → snapshot 帧', async () => {
		const frames = await readStream(url, state.cookie, 'session/follow', {
			args: { request: { address: { kind: 'session', sessionId: state.sessionId } } },
		}, 1, timeoutMs)
		const frame = frames[0]
		expect(frame?.type === 'item', `首帧应为 item，实际 ${frame?.type}`)
		expectKeys(frame.value, ['type', 'header', 'projections', 'cursor', 'records'], 'follow snapshot')
		expect(frame.value.type === 'snapshot', `snapshot 帧类型不符: ${frame.value.type}`)
		expectKeys(frame.value.header, ['version', 'id', 'cwd'], 'follow header')
		return `header.version=${frame.value.header.version} projections=${Object.keys(frame.value.projections.values ?? {}).length}`
	})

	await record('WS 上开 unary 方法 → signature-invalid', async () => {
		let error
		try {
			await readStream(url, state.cookie, 'session/list', { args: { _request: {} } }, 1, 5000)
		} catch (caught) {
			error = caught.message
		}
		expect(error !== undefined, 'unary 方法走 stream carrier 应被拒，实际通过了')
		expect(error.includes('gateway/signature-invalid'), `错误码不符: ${error}`)
		return 'gateway/signature-invalid（符合预期）'
	})

	await record('args 形参名错误 → arguments-invalid', async () => {
		const res = await post(url, state.cookie, 'session/list', { args: {} }, timeoutMs)
		const error = res.json?.result?.error
		expect(error?.code === 'gateway/arguments-invalid', `错误码不符: ${error?.code}`)
		expect(String(error.message).includes('missing'), '错误信息应指出缺失的形参名')
		return String(error.message).replace(/^typert gateway: /, '')
	})

	return results
}

// -------------------------------------------------------------------- 主流程 ---

async function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.token === '') {
		console.error('缺少 --token：从 `dsh web` 启动输出里的 /?token= 后面取。')
		process.exitCode = 2
		return
	}
	const state = {}
	const results = await run(args, state)

	let failed = 0
	for (const result of results) {
		const mark = result.ok ? 'PASS' : 'FAIL'
		if (!result.ok) failed++
		console.log(`${mark}  ${result.name}  (${result.ms}ms)`)
		if (args.verbose || !result.ok) console.log(`      ${result.detail}`)
	}
	console.log(`\n${results.length - failed}/${results.length} 通过`)
	process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
	console.error(`SUITE FAILED: ${error.message}`)
	process.exitCode = 1
})
