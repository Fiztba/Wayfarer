import assert from 'node:assert/strict'
import { isOwnPage } from '../src/main/navigation.ts'
const own = 'file:///C:/Wayfarer/out/renderer/index.html'
assert.equal(isOwnPage(own, own), true)
assert.equal(isOwnPage(own + '#popout/123', own), true)
assert.equal(isOwnPage('file:///C:/Downloads/untrusted.html', own), false)
assert.equal(isOwnPage('file://remote/C:/Wayfarer/out/renderer/index.html', own), false)
assert.equal(isOwnPage('https://example.com', own), false)
assert.equal(isOwnPage('http://localhost:5173/#popout/123', own, 'http://localhost:5173'), true)
assert.equal(isOwnPage('http://localhost:5174/', own, 'http://localhost:5173'), false)
assert.equal(isOwnPage('garbage', own), false)
console.log('navigation-smoke: 8 checks passed')
