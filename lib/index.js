/**
 * Host half of dsh-session-delete: carry ONE destructive operation, as safely as this platform allows.
 *
 * WHY THIS PLUGIN EXISTS AT ALL. Measured 2026-10-15 against the live service catalog:
 *   sessionPersistence  -- "Durable append-only session storage" (no delete method)
 *   sessionController   -- Remote: list/search/create/rename/fork/prompt/cancel/page/follow/projections/control
 *                          (no delete)
 *   workspaceRegistry   -- archiveSession / unarchiveSession / pinSession / unpinSession (no deleteSession)
 * So the UI has Archive and Pin and no Delete NOT because of an oversight, but because the platform models
 * sessions as append-only. A real delete therefore has to be built from the pieces that DO exist:
 * the registry's own methods, and the files on disk.
 *
 * THE FOUR RULES THIS HALF FOLLOWS, each one a scar rather than a preference:
 *  1. USE THE REGISTRY'S OWN CALLS -- `ws.detachSession(id)`, then `unarchiveSession(id)` and
 *     `unpinSession(id)`. The first version instead opened the live storage domain (`storageDomain.get`)
 *     and rewrote `table('workspaces')` by hand: it worked, and it was wrong, because it skipped the
 *     registry's accounting (canonical-cwd header index, durable order). The supported calls exist; they
 *     were missed because only the service's top-level method list was read, while the useful ones hang off
 *     its RETURN type (`Workspace`). Reading a service means reading what it hands back, not just what it
 *     accepts. NEVER hand-edit workspace.json either: the service owns that file and writes it back.
 *  2. STOP A LIVE SESSION, DO NOT REFUSE IT. Deleting a session whose agent is running would pull the log
 *     out from under a process holding a handle -- but the first version answered 409 "close it first", and
 *     the sidebar has no "close session" action, so the refusal named a step the UI cannot perform. The
 *     owner hit it immediately (2026-10-18). `archiveSession(id, { stopActivity: true })` is the platform's
 *     own way to stop the work first; only if the agent survives that is there anything to refuse.
 *  3. TWO KINDS OF DELETE (owner, 2026-10-18: "正常删除根本不是删除"). Default = move the bytes into
 *     `$DSH_HOME/.trash-sessions/<stamp>/`, which is why the UI does NOT ask. `permanent: true` = remove the
 *     directory, and the UI asks "are you sure" for that branch only.
 *  4. FAIL CLOSED ON THE FENCE. `webServer.register` provides no authentication of its own; a route that
 *     does not refuse is simply open. Copied from dsh-skill-tree the hard way: the fence needs `connection`
 *     INJECTED, not merely looked up, or the "no fence available" arm allows everything.
 */
import { readdirSync, existsSync, mkdirSync, renameSync, rmSync, statSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const name = 'session-delete';

const ROUTE = '/session-delete/delete';

function dshHome() {
	return process.env.DSH_HOME || 'C:\\Users\\36068\\.dsh';
}

/**
 * Move a directory into the WINDOWS Recycle Bin, so the owner can restore it from Explorer
 * (or empty it there) instead of hunting for a folder this plugin invented.
 *
 * Why a PowerShell call: Node has no API for the shell recycle bin, and the alternatives
 * (SHFileOperation via ffi, or Shell.Application InvokeVerb) either need a native addon or
 * pop a confirmation dialog. Microsoft.VisualBasic.FileIO does exactly this, with
 * OnlyErrorDialogs so it never asks.
 */
function sendToRecycleBin(dir) {
	const esc = String(dir).replace(/'/g, "''");
	const ps = [
		'Add-Type -AssemblyName Microsoft.VisualBasic;',
		`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${esc}',`,
		"'OnlyErrorDialogs', [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
	].join(' ');
	const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
		encoding: 'utf8',
		timeout: 30000,
		windowsHide: true,
	});
	if (r.error) throw r.error;
	if (r.status !== 0) {
		throw new Error(((r.stderr || r.stdout || '') + '').trim().slice(0, 300) || 'recycle bin refused the move');
	}
}

/**
 * Files elsewhere under DSH_HOME that name a session. Measured 2026-11-26: after a session was
 * removed from the registry and its directory was gone, the id — and in one case a whole reply,
 * verbatim — was still sitting in five of these.
 */
const SWEEP_FILES = [
	'main-session.json',
	'session-send-delivered.json',
	'storages/workspace.json',
	'qq-bridge/transcript.jsonl',
	'prompt-inherit.log',
	'subagent-policy.log',
];

/** Remove every mention of `id` from known text stores. Lines out of .jsonl/.log, keys out of .json. */
export function sweepReferences(sessionId, warnings) {
	const home = dshHome();
	let lines = 0;
	let keys = 0;
	for (const rel of SWEEP_FILES) {
		const p = join(home, rel);
		if (!existsSync(p)) continue;
		try {
			const raw = readFileSync(p, 'utf8');
			if (!raw.includes(sessionId)) continue;
			if (p.endsWith('.jsonl') || p.endsWith('.log')) {
				const before = raw.split('\n');
				const kept = before.filter((l) => !l.includes(sessionId));
				if (kept.length !== before.length) {
					writeFileSync(p, kept.join('\n'));
					lines += before.length - kept.length;
				}
			} else {
				const obj = JSON.parse(raw);
				const n = pruneRefs(obj, sessionId);
				if (n) {
					writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
					keys += n;
				}
			}
		} catch (e) {
			warnings.push('sweep ' + rel + ': ' + String((e && e.message) || e));
		}
	}
	return { lines, keys };
}

export function pruneRefs(node, id) {
	if (Array.isArray(node)) {
		let n = 0;
		for (let i = node.length - 1; i >= 0; i--) {
			if (typeof node[i] === 'string' && node[i].includes(id)) {
				node.splice(i, 1);
				n += 1;
			} else {
				n += pruneRefs(node[i], id);
			}
		}
		return n;
	}
	if (!node || typeof node !== 'object') return 0;
	let n = 0;
	for (const k of Object.keys(node)) {
		const v = node[k];
		if (k.includes(id) || (typeof v === 'string' && v.includes(id))) {
			delete node[k];
			n += 1;
			continue;
		}
		n += pruneRefs(v, id);
	}
	return n;
}

/**
 * Session ids come in TWO shapes on disk, measured 2026-10-15:
 *    session-<uuid>   12 of them -- the sessions the sidebar shows
 *    <uuid>           29 of them -- the subagent sessions
 * The first regex written here accepted only the `session-` form and therefore located 2 of 10 sampled
 * directories. Both shapes are taken now, and the whole value must be ONE uuid (optionally prefixed), which
 * is what keeps `../../etc` and `C:\Windows` out of the filesystem path below.
 */
function isSessionId(v) {
	if (typeof v !== 'string' || v.length > 60) return false;
	const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
	return new RegExp('^(session-)?' + uuid + '$', 'i').test(v);
}

/** Find `sessions/<workspace-slug>/<sessionId>` without assuming the slug for this session's workspace. */
function findSessionDir(sessionId) {
	const root = join(dshHome(), 'sessions');
	let slugs;
	try {
		slugs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return null;
	}
	for (const slug of slugs) {
		const dir = join(root, slug, sessionId);
		try {
			if (statSync(dir).isDirectory()) return { dir, slug };
		} catch {
			/* not in this workspace; keep looking */
		}
	}
	return null;
}

function readJsonBody(req, limitBytes = 64 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
			chunks.push(c);
		});
		req.on('end', () => {
			try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
			catch (e) { reject(e); }
		});
		req.on('error', reject);
	});
}

export function apply(root) {
	// `workspaceRegistry` is the HARD dependency. The first version injected `storageDomain` and poked
	// `table('workspaces').update` by hand -- it worked, but it bypassed the registry's own accounting
	// (the canonical-cwd header index, the durable order). The registry contract turned out to expose the
	// supported calls all along, and they were missed because only the service's TOP-LEVEL methods were
	// read while the useful ones hang off its return type:
	//   Workspace.detachSession(id)   -- remove the session from the workspace, with accounting
	//   registry.unarchiveSession(id) -- drop the archive entry (idempotent)
	//   registry.unpinSession(id)     -- drop the pin (idempotent; archiving already drops it)
	//   registry.archiveSession(id, { stopActivity: true }) -- stop live work first
	// Use those. A plugin that edits another service's storage is a plugin that will break on the next
	// schema change and blame the upgrade.
	root.inject(['webServer', 'connection', 'workspaceRegistry', 'tools'], (ctx) => {
		const fence = () => {
			try {
				const conn = (ctx.get ? ctx.get('connection') : null) || ctx.connection;
				return conn && typeof conn.requestRejection === 'function' ? conn : null;
			} catch { return null; }
		};

		// A security control that fails open must at least say so out loud.
		if (!fence()) {
			try {
				console.warn('[session-delete] host trust fence unavailable (connection.requestRejection missing): '
					+ 'the delete route would answer without authentication. It refuses to register instead.');
			} catch { /* no console */ }
			return;                                   // no fence, no destructive route -- fail closed by absence
		}

		const rejected = (req, res) => {
			const conn = fence();
			if (!conn) { res.writeHead(503); res.end(); return true; }
			let code;
			try { code = conn.requestRejection(req); }
			catch {
				try { res.statusCode = 403; res.end(); } catch { /* response already gone */ }
				return true;                          // a fence that throws is not a fence that passed
			}
			if (code) {
				try { res.statusCode = code; res.end(); } catch { /* response already gone */ }
				return true;
			}
			return false;
		};

		const json = (res, code, body) => {
			res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			res.end(JSON.stringify(body));
		};

		// 2026-11-13: 给 agent 一个删除入口，复用与路由相同的 registry 流程。
		// 单项删除的全部流程（原 execute 体，语义未改）
		async function deleteOne(args) {
			const sid = String(args.session_id || '')
			if (!isSessionId(sid)) return { ok: false, error: 'bad sessionId' }
			const permanent = args.permanent === true
			const steps = []
			try {
				await ctx.workspaceRegistry.archiveSession(sid, { stopActivity: true })
				steps.push('archived')
			} catch (e) {
				steps.push('archive-skip: ' + String((e && e.message) || e))
				return { ok: false, error: '归档失败：' + String((e && e.message) || e), sessionId: sid, permanent: false, steps }
			}
			if (!permanent) {
				steps.push('kept-on-disk')
				return { ok: true, sessionId: sid, permanent: false, steps }
			}
			try {
				if (args.force !== true) {
					let why = 'ownership-unknown'
					try {
						const sc = ctx.get && ctx.get('sessionController')
						if (sc && sc.list) {
							const items = ((await sc.list({}, new AbortController().signal)) || {}).items || []
							const me = items.find((x) => x && x.sessionId === sid)
							if (me && (me.origin === 'subagent' || me.parentSessionId)) why = 'referenced-subagent'
							else if (me) why = null
							if (why === null) {
								const sub = ctx.get && ctx.get('subagents')
								if (!sub || !sub.listDescendants) why = 'descendants-unknown'
								else {
									const kids = await sub.listDescendants(sid, new AbortController().signal)
									if (Array.isArray(kids) && kids.length > 0) why = 'has-descendants (' + kids.length + ')'
								}
							}
						}
					} catch { why = 'ownership-unknown' }
					if (why) {
						steps.push('refused-delete: ' + why)
						return { ok: false, error: '拒绝删盘（' + why + '）；已归档，未动磁盘。要强删给 force:true。', sessionId: sid, permanent: false, steps }
					}
				}
				const found = findSessionDir(sid)
				let dir = null
				if (found) {
					dir = found.dir
					const normalized = String(dir).replace(/\\/g, '/')
					if (!/\/sessions\//.test(normalized)) {
						return { ok: false, error: 'refuse: 路径不在 sessions 根下 · ' + dir, steps, sessionId: sid }
					}
					rmSync(dir, { recursive: true, force: true })
					steps.push('deleted')
					try { await ctx.workspaceRegistry.unarchiveSession(sid); steps.push('unarchived') } catch (e) { steps.push('unarchive-skip: ' + String((e && e.message) || e)) }
					try { await ctx.workspaceRegistry.unpinSession(sid) } catch { /* 归档本来就会撤 pin */ }
					// 清标题缓存，否则侧栏留个鬼影
					try { const cf = join(dshHome(), 'storages', 'session_projcache', 'sessions', sid + '.json'); if (existsSync(cf)) rmSync(cf, { force: true }) } catch { /* 缓存可重建 */ }
				}
				return { ok: true, sessionId: sid, dir, permanent, steps }
			} catch (e) {
				return { ok: false, error: String((e && e.message) || e), steps, sessionId: sid }
			}
		}

		const deleteTool = {
			name: 'session_delete',
			description: '清理 DSH 会话，支持批量：传 session_ids 数组。默认只归档并从列表摘除（可逆，不动磁盘）；permanent:true 才删目录（不可逆）。harden-2026-11-16+batch',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					session_id: { type: 'string', description: '单个会话 id，形如 session-<uuid>（与 session_ids 二选一）' },
					session_ids: { type: 'array', items: { type: 'string' }, description: '批量：会话 id 数组' },
					permanent: { type: 'boolean', description: '默认 false：只归档+摘除；true 才删除磁盘目录（不可逆）' },
					force: { type: 'boolean', description: '目标是被引用的子会话/归属查不清时，仍要删盘才给 true' },
				},
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: true,
					properties: {
						ok: { type: 'boolean' },
						sessionId: { type: 'string' },
						dir: { type: 'string' },
						error: { type: 'string' },
						total: { type: 'number' },
						okCount: { type: 'number' },
					},
				},
				render: (_a, v) => {
					if (v && v.batch) {
						const bad = (v.results || []).filter((r) => !r.ok)
						return [{ type: 'text', text: '批量：' + v.okCount + '/' + v.total + ' 成功' + (bad.length ? '\n失败：' + bad.map((r) => r.sessionId + ' (' + r.error + ')').join(' / ') : '') }]
					}
					return [{ type: 'text', text: (v?.ok ? (v.permanent ? '已删除' : '已归档') + ' ' + v.sessionId + (v.dir ? ' · ' + v.dir : '') : '失败：' + (v?.error ?? 'unknown')) + (Array.isArray(v?.steps) ? '\n' + v.steps.join(' / ') : '') }]
				},
			},
			async execute(args) {
				const ids = Array.isArray(args.session_ids) && args.session_ids.length
					? args.session_ids.map(String)
					: [String(args.session_id || '')]
				if (ids.length === 1) return deleteOne({ session_id: ids[0], permanent: args.permanent, force: args.force })
				const results = []
				for (const id of ids) {
					try { results.push(await deleteOne({ session_id: id, permanent: args.permanent, force: args.force })) }
					catch (e) { results.push({ ok: false, sessionId: id, error: String((e && e.message) || e) }) }
				}
				const okCount = results.filter((r) => r.ok).length
				return { ok: okCount === results.length, batch: true, total: results.length, okCount, results }
			},
		}
		try { ctx.effect(() => ctx.tools.register(deleteTool)) } catch (e) { console.warn('[session-delete] tool 注册失败: ' + ((e && e.message) || e)) }

		root.effect(() => ctx.webServer.register({
			// `kind` IS REQUIRED. Measured 2026-10-15 after the first restart: registering `{ path, handler }`
			// without it left the route unmatched, so the request fell through to the SPA fallback and the app
			// answered 405 -- not 404, not my own 400. The contract says
			// `WebRoute { kind: 'exact' | 'prefix'; path; handler }`; omit `kind` and the route never claims
			// the path, which from the browser looks exactly like a dead button.
			kind: 'exact',
			path: ROUTE,
			handler: async (req, res) => {
				if (rejected(req, res)) return;
				if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

				let body;
				try { body = await readJsonBody(req); }
				catch (e) { return json(res, 400, { error: 'bad body: ' + e.message }); }

				const sessionId = body && body.sessionId;
				if (!isSessionId(sessionId)) return json(res, 400, { error: 'bad sessionId' });

				// RULE 2 -- STOP BUSY WORK, AND LET THE PLATFORM DECIDE WHAT "BUSY" MEANS.
				// Three versions, two of them wrong, all three hit by the owner within the hour:
				//   v1  409 "close it first"            -> names a step the sidebar cannot perform.
				//   v2  agents.get(id) as the liveness test, then "did it survive?" -> `agents.get` answers
				//       "does an agent OBJECT exist for this session", and one exists for every session the
				//       app has opened, so the survivor check was ALWAYS true and every delete was 409
				//       (owner, 2026-10-18: "我刚才删除「开启创造模式」这个会话，删不掉").
				//   v3  ask the activity question through the registry itself. Its contract: calling
				//       archiveSession WITHOUT stopActivity asks the `workspace/session-activity` waterfall once
				//       and rejects with WorkspaceActiveSessionError when the session is working. So:
				//         try the plain archive -> if it rejects as active, retry with stopActivity.
				//       No guess about liveness, and no refusal unless the platform explicitly refuses.
				let stoppedLiveAgent = false;
				try {
					try {
						await ctx.workspaceRegistry.archiveSession(sessionId);
					} catch (e) {
						const name = String((e && (e.name || e.code)) || '');
						const msg = String((e && e.message) || e);
						const all = name + ' ' + msg;
						if (/ActiveSession|active/i.test(all)) {
							// It is working right now: archive again WITH stopActivity, which issues the stops.
							await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true });
							stoppedLiveAgent = true;
						} else if (/not.?found|unknown|does not exist|must exist/i.test(all)) {
							// No durable session to archive (e.g. only the directory survives). Nothing to stop;
							// continue and let the file step do the real work.
						} else {
							throw e;
						}
					}
				} catch (e) {
					// Do not claim WHY it refused when the platform only said "no": the likely cause is that
					// this turn is still running, but the message must not assert more than we measured.
					return json(res, 409, {
						error: 'live',
						detail: '归档/停止这个会话失败，没有删除任何东西。多半是它这一轮还在跑，等它结束再试。平台原话：'
							+ String((e && e.message) || e),
					});
				}

				// RULE 1: take the session out of the registry through ITS OWN API, not by editing its store.
				let removedFromRegistry = false;
				const warnings = [];
				try {
					const registry = ctx.workspaceRegistry;
					for (const ws of registry.list()) {
						const ids = (ws && ws.sessionIds) || [];
						if (!ids.includes(sessionId)) continue;
						await ws.detachSession(sessionId);
						removedFromRegistry = true;
					}
					// Both are idempotent and both are no-ops for an id they do not hold. Their failures are
					// collected rather than swallowed: a silent catch here would hide the one case where the
					// row stays in the archived list after we claimed to delete it.
					await registry.unarchiveSession(sessionId).catch((e) => warnings.push('unarchive: ' + String((e && e.message) || e)));
					await registry.unpinSession(sessionId).catch((e) => warnings.push('unpin: ' + String((e && e.message) || e)));
				} catch (e) {
					return json(res, 500, { error: 'registry', detail: String(e && e.message || e) });
				}

				// RULE 3 -- TWO KINDS OF "DELETE", because the owner split them on 2026-10-18:
				//   default      : move the bytes into the WINDOWS Recycle Bin (falls back to this plugin's
				//                  own folder when the volume has none). Not a destruction, so the UI does
				//                  not ask.
				//   permanent    : `body.permanent === true` -- destroy the directory outright, no trash copy.
				//                  The UI asks "are you sure" for THIS branch only.
				const permanent = !!(body && body.permanent === true);
				let movedTo = null;
				let destroyed = false;
				try {
					const found = findSessionDir(sessionId);
					if (found) {
						// Windows refuses to move a directory that contains an open handle, and the app can
						// still hold this session's log for a moment after the stop. Three short retries turn
						// a confusing EBUSY into a success in the common case; a real lock still reports.
						const withRetry = async (fn) => {
							let last;
							for (let i = 0; i < 3; i++) {
								try { return fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 250)); }
							}
							throw last;
						};
						if (permanent) {
							// Belt and braces: never rm a path that is not a direct child of the sessions root.
							const root = join(dshHome(), 'sessions');
							const parent = found.dir.slice(0, found.dir.length - sessionId.length - 1);
							if (parent !== join(root, found.slug)) {
								return json(res, 400, { error: 'refused', detail: 'path is not a direct child of the sessions root' });
							}
							await withRetry(() => rmSync(found.dir, { recursive: true, force: true }));
							destroyed = true;
						} else {
							// Default: the Windows Recycle Bin, so the owner restores or empties it where he
							// already expects to find deleted things. If the volume has no recycle bin (network
							// share, some external disks) fall back to this plugin's own folder rather than
							// failing the delete.
							try {
								await withRetry(() => sendToRecycleBin(found.dir));
								movedTo = 'recycle-bin';
							} catch (e) {
								const stamp = new Date().toISOString().replace(/[:.]/g, '-');
								const dest = join(dshHome(), '.trash-sessions', stamp, sessionId);
								mkdirSync(join(dshHome(), '.trash-sessions', stamp), { recursive: true });
								await withRetry(() => renameSync(found.dir, dest));
								movedTo = dest;
								warnings.push('recycle-bin unavailable (' + String((e && e.message) || e).slice(0, 120) + '), fell back to .trash-sessions');
							}
						}
					}
				} catch (e) {
					return json(res, 500, {
						error: 'files',
						detail: String(e && e.message || e),
						registryRemoved: removedFromRegistry,
						note: 'the row was removed from the registry but the files could not be moved; check permissions',
					});
				}

				// RULE 5 -- SWEEP THE TITLE CACHE, and write one audit line.
				// Measured 2026-10-18 on the owner's "研究 F:\DSH 目录": after the registry entry AND the session
				// directory were both gone, `storages/session_projcache/sessions/<id>.json` was still there and the
				// sidebar kept rendering a row for it. A delete that leaves the title behind leaves a ghost.
				// The cache is redundant (rebuilt from the log), so removing it is safe; a failure here is
				// reported but must not undo the delete.
				const cacheFile = join(dshHome(), 'storages', 'session_projcache', 'sessions', sessionId + '.json');
				try { if (existsSync(cacheFile)) rmSync(cacheFile, { force: true }); }
				catch (e) { warnings.push('projcache: ' + String((e && e.message) || e)); }

				// RULE 6 -- PERMANENT MEANS NO TRACE, INCLUDING OUTSIDE THE SESSION DIRECTORY.
				// Measured 2026-11-26: after a real delete, the id still appeared in five text files,
				// and one of them held a whole reply verbatim. A recoverable move is allowed to leave
				// those behind (the session is coming back); a destruction is not.
				let swept = null;
				if (permanent) {
					swept = sweepReferences(sessionId, warnings);
				}

				// One line per operation, in the vault (never the repo): the next "it would not delete" report can
				// be checked against what the host actually did instead of against a screenshot.
				try {
					appendFileSync(join(dshHome(), 'session-delete.log'),
						JSON.stringify({
							at: new Date().toISOString(), sessionId, permanent,
							destroyed, stoppedLiveAgent, registryRemoved, movedTo,
							cacheRemoved: !existsSync(cacheFile), swept, warnings,
						}) + '\n');
				} catch { /* a log failure must not fail the operation */ }

				return json(res, 200, { ok: true, sessionId, permanent, destroyed, stoppedLiveAgent, registryRemoved: removedFromRegistry, movedTo, swept, warnings });
			},
		}));
	});
}
