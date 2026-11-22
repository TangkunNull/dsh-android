#!/usr/bin/env node
/**
 * 探路工具：直连真实 dsh Host（0.2.2-rc.1 Typert / dsh-api-gateway）跑通调用。
 *
 * 已验证的两条通路（2026-11-18，对 dsh web 0.2.2-rc.1 实测）：
 *
 *   1. 认证：`GET /?token=<launch-token>` → 303 + `Set-Cookie: dsh-auth-<hash>=v1.<...>`
 *      cookie 名带按 authority 算出的哈希后缀，所以不要硬编码名字，从响应头取。
 *      之后所有请求只带这条 cookie；Bearer / x-dsh-token 一律不认。
 *
 *   2. unary 方法（`session/list`、`session/create`、`session/state`、`session/modelCatalog`…）
 *      走 HTTP：`POST /api/<namespace>/<method>`，body 是
 *        {type:'client-request', rpcId, method:'<namespace>/<method>', payload:{args:{...}}}
 *      注意 endpoint 分隔符是 **斜杠**，不是点号；点号会被 endpoint 解析拒掉 → 404。
 *      返回 {type:'server-response', rpcId, result:{ok:true,value}} 或 {ok:false,error}。
 *
 *   3. stream 方法（`session/observeState`、`session/follow`、`session/control`…）
 *      走 WebSocket `/api/remote.mux`，握手带同一条 cookie：
 *        发 {type:'open', streamId, endpoint, payload:{args:{...}}}
 *        收 {type:'item', streamId, value} … {type:'end', streamId} / {type:'error', ...}
 *
 *   ⚠️ args 的 key 是**方法形参名**，不是固定字段：
 *        session/list(_request)      → {args:{_request:{}}}
 *        session/create(request)     → {args:{request:{...}}}
 *        session/modelCatalog()      → {args:{}}
 *      猜错会收到 `gateway/arguments-invalid: ... missing "<name>"`，这条错误信息就是答案。
 *
 * 用法：
 *   node probe-gateway.mjs --token <t> --endpoint session/list
 *   node probe-gateway.mjs --token <t> --endpoint session/create --payload '{"args":{"request":{"cwd":"/tmp/x"}}}'
 *   node probe-gateway.mjs --token <t> --endpoint session/observeState --stream --max-items 1 \
 *        --payload '{"args":{"request":{"sessionId":"session-..."}}}'
 *
 * 退出码：0 成功；1 失败。
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 默认探路参数。 */
const DEFAULTS = {
	url: 'http://127.0.0.1:3080',
	token: '',
	endpoint: 'session/list',
	payload: null,
	stream: false,
	maxItems: 1,
	timeoutMs: 10000,
	quiet: false,
}

/** 解析命令行；未知参数直接拒绝，避免静默走默认值。 */
function parseArgs(argv) {
	const out = { ...DEFAULTS }
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
			case '--endpoint': out.endpoint = next(); break
			case '--payload': out.payload = next(); break
			case '--stream': out.stream = true; break
			case '--max-items': out.maxItems = Number(next()); break
			case '--timeout': out.timeoutMs = Number(next()); break
			case '--quiet': out.quiet = true; break
			case '-h':
			case '--help': out.help = true; break
			default: throw new Error(`unknown argument ${key}`)
		}
	}
	if (out.payload === null) out.payload = defaultPayloadFor(out.endpoint)
	return out
}

/**
 * 按已实测的形参名给出默认 args。
 * 拿不到对应条目时退回空 args，让 Host 的 `missing "<name>"` 错误替我们报答案。
 */
function defaultPayloadFor(endpoint) {
	const known = {
		'session/list': { args: { _request: {} } },
		'session/modelCatalog': { args: {} },
		'session/canOpenWorkspacePath': { args: {} },
		'session/initializeDefaultModel': { args: {} },
	}
	return known[endpoint] ?? { args: {} }
}

/**
 * `GET /?token=` 换浏览器 cookie。
 * Host 用 303 + Set-Cookie 回应；cookie 名带 authority 哈希，故从响应头取。
 */
async function exchangeToken(baseUrl, token) {
	const url = new URL('/', baseUrl)
	if (token !== '') url.searchParams.set('token', token)
	const response = await fetch(url, { redirect: 'manual' })
	const setCookie = response.headers.getSetCookie?.() ?? []
	const auth = setCookie.find((line) => line.startsWith('dsh-auth-'))
	if (auth === undefined) {
		throw new Error(`token exchange failed: status=${response.status} set-cookie=${JSON.stringify(setCookie)}`)
	}
	const pair = auth.split(';', 1)[0]
	return { status: response.status, cookie: pair, cookieName: pair.split('=', 1)[0] }
}

/** unary 方法：POST /api/<endpoint>，返回 result.value。 */
async function callUnary(baseUrl, cookie, endpoint, payload, timeoutMs) {
	const url = new URL(`/api/${endpoint}`, baseUrl)
	const envelope = { type: 'client-request', rpcId: `probe-${Date.now()}`, method: endpoint, payload }
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify(envelope),
		signal: AbortSignal.timeout(timeoutMs),
	})
	const text = await response.text()
	if (response.status !== 200) {
		throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
	}
	let decoded
	try {
		decoded = JSON.parse(text)
	} catch {
		throw new Error(`non-JSON response: ${text.slice(0, 300)}`)
	}
	if (decoded?.result?.ok !== true) {
		const failure = decoded?.result?.error ?? {}
		throw new Error(`${failure.code ?? 'unknown'}: ${failure.message ?? text.slice(0, 300)}`)
	}
	return decoded.result.value
}

/** stream 方法：WS /api/remote.mux，收到 maxItems 个 item 或 end 即收口。 */
function callStream(baseUrl, cookie, endpoint, payload, maxItems, timeoutMs) {
	const { WebSocket } = require('ws')
	const wsUrl = new URL('/api/remote.mux', baseUrl)
	wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
	const socket = new WebSocket(wsUrl, { headers: { cookie } })
	const streamId = `probe-${Date.now()}`

	return new Promise((resolve, reject) => {
		const items = []
		const timer = setTimeout(() => {
			// 长驻流不会 end：时间到但 item 够数就判成功。
			if (items.length >= maxItems) {
				cleanup()
				resolve(items)
				return
			}
			cleanup()
			reject(new Error(`stream ${endpoint} timed out after ${timeoutMs}ms (items=${items.length})`))
		}, timeoutMs)

		function cleanup() {
			clearTimeout(timer)
			socket.off('message', onMessage)
			socket.off('close', onClose)
			socket.off('error', onError)
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
				cleanup()
				reject(new Error(`non-JSON frame: ${String(data).slice(0, 200)}`))
				return
			}
			if (frame.streamId !== streamId) return
			if (frame.type === 'item') {
				items.push(frame.value)
				if (items.length >= maxItems) {
					cleanup()
					resolve(items)
				}
				return
			}
			if (frame.type === 'end') {
				cleanup()
				resolve(items)
				return
			}
			if (frame.type === 'error') {
				cleanup()
				reject(new Error(`remote error ${frame.error?.code}: ${frame.error?.message}`))
			}
		}
		function onClose(code, reason) {
			cleanup()
			if (items.length >= maxItems) {
				resolve(items)
				return
			}
			reject(new Error(`socket closed before enough items: code=${code} reason=${String(reason)} items=${items.length}`))
		}
		function onError(error) {
			cleanup()
			reject(error)
		}

		socket.on('message', onMessage)
		socket.on('close', onClose)
		socket.on('error', onError)
		socket.on('open', () => {
			socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
		})
		socket.on('unexpected-response', (_request, response) => {
			cleanup()
			reject(new Error(`WS upgrade rejected: HTTP ${response.statusCode}`))
		})
	})
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.help) {
		console.log('usage: node probe-gateway.mjs --token <launch-token> [--endpoint session/list] [--stream] [--max-items N]')
		return
	}
	const log = args.quiet ? () => {} : (text) => console.log(text)
	const payload = typeof args.payload === 'string' ? JSON.parse(args.payload) : args.payload

	log(`[1] token 交换 ${args.url}/?token=${args.token === '' ? '(none)' : '<redacted>'}`)
	const auth = await exchangeToken(args.url, args.token)
	log(`[2] cookie ${auth.cookieName}=… (status ${auth.status})`)

	log(`[3] ${args.stream ? 'WS' : 'HTTP'} 调用 ${args.endpoint} payload=${JSON.stringify(payload)}`)
	const value = args.stream
		? await callStream(args.url, auth.cookie, args.endpoint, payload, args.maxItems, args.timeoutMs)
		: await callUnary(args.url, auth.cookie, args.endpoint, payload, args.timeoutMs)

	log('[4] 成功')
	console.log(JSON.stringify(value, null, 2))
}

main().catch((error) => {
	console.error(`PROBE FAILED: ${error.message}`)
	process.exitCode = 1
})
