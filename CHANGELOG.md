# Changelog

## [0.10.0](https://github.com/maxdewald/vscode-universal-chat-provider/compare/v0.9.0...v0.10.0) (2026-06-22)


### Features

* honor proxy default reasoning level, fall back to second-highest ([ffff853](https://github.com/maxdewald/vscode-universal-chat-provider/commit/ffff8538df65579c9e957d428c9316a0712990f8))


### Bug Fixes

* log cache diffs around divergence ([dc53d9b](https://github.com/maxdewald/vscode-universal-chat-provider/commit/dc53d9b3c93fc1ece5be5fbd3ce81d35ddd7393b))

## [0.9.0](https://github.com/maxdewald/vscode-universal-chat-provider/compare/v0.8.3...v0.9.0) (2026-06-21)


### Features

* drop output-token fallback setting, skip models with no limit ([959ccd3](https://github.com/maxdewald/vscode-universal-chat-provider/commit/959ccd3c87db2b75c4bf80d9512eb21e650717e0))
* log and resolve model display name collisions ([423d2cd](https://github.com/maxdewald/vscode-universal-chat-provider/commit/423d2cdc1f02ce042ecd200e8c1d850e7095341b))
* support reasoning effort for utility models ([51571cc](https://github.com/maxdewald/vscode-universal-chat-provider/commit/51571cc9d90a6551036127cc42afe336aff48dd8))

## [0.8.3](https://github.com/maxdewald/vscode-universal-chat-provider/compare/v0.8.2...v0.8.3) (2026-06-19)


### Bug Fixes

* moderndash startup crash because it was not bundled ([e01ad03](https://github.com/maxdewald/vscode-universal-chat-provider/commit/e01ad0320e273451ef2b207c03a5a6be2016a80c))

## [0.8.2](https://github.com/maxdewald/vscode-universal-chat-provider/compare/v0.8.1...v0.8.2) (2026-06-19)


### Bug Fixes

* lockfile ([7bc0c46](https://github.com/maxdewald/vscode-universal-chat-provider/commit/7bc0c46af5686655b6ac803fbc744e0349c49238))

## [0.8.1](https://github.com/maxdewald/vscode-universal-chat-provider/compare/v0.8.0...v0.8.1) (2026-06-19)


### Bug Fixes

* reasoning and thinking selectors brought back ([dd50d11](https://github.com/maxdewald/vscode-universal-chat-provider/commit/dd50d116375994d62aa3c19b1b9c079ab7b928e5))

## [0.8.0](https://github.com/maxdewald/vscode-universal-chat-provider/compare/v0.7.4...v0.8.0) (2026-06-18)


### Features

* only use proposed apis and fix marketplace install ([26a14d7](https://github.com/maxdewald/vscode-universal-chat-provider/commit/26a14d73bfc6ad7eee6cb4c6695aa7ea497018e5))

## [0.7.4](https://github.com/maxdewald/vscode-universal-chat-provider/compare/v0.7.3...v0.7.4) (2026-06-18)


### Documentation

* add Kimi badge to README for visibility ([c11409e](https://github.com/maxdewald/vscode-universal-chat-provider/commit/c11409e7e490f5c9d40f0204fc413b0594e4d94e))
* clarify VS Code Copilot Chat positioning, fix retired badges ([387037e](https://github.com/maxdewald/vscode-universal-chat-provider/commit/387037e374ecc6da68b699df5914c3f12a81e570))
* update package description for clarity and detail ([587654d](https://github.com/maxdewald/vscode-universal-chat-provider/commit/587654d2d0f72b9500a1795a1fc9442b5b75a009))
* update README badges for consistency and clarity ([ba881d9](https://github.com/maxdewald/vscode-universal-chat-provider/commit/ba881d9a77648ce92478d6cb9a94f3be3cf523d4))
* update README for command formatting and clarity ([def1fef](https://github.com/maxdewald/vscode-universal-chat-provider/commit/def1fef8f40bc33fc9644a51a71886985cf51438))

## [0.7.3](https://github.com/maxdewald/universal-chat-provider/compare/v0.7.2...v0.7.3) (2026-06-18)


### Bug Fixes

* normalize tilde-expanded config paths on Windows ([b0ed2b9](https://github.com/maxdewald/universal-chat-provider/commit/b0ed2b951c233522958caee9efcac6a01d9a7cd1))


### Documentation

* update README for Marketplace launch ([cd91053](https://github.com/maxdewald/universal-chat-provider/commit/cd910533a92d23efccd230bfd80d5d837dc05b41))

## [0.7.2](https://github.com/maxdewald/universal-chat-provider/compare/v0.7.1...v0.7.2) (2026-06-17)


### Bug Fixes

* drop unused contribSourceControlInputBoxMenu proposed api ([6d8ca95](https://github.com/maxdewald/universal-chat-provider/commit/6d8ca95dd896a066bd28c627d75cc58c822f5a70))

## [0.7.1](https://github.com/maxdewald/universal-chat-provider/compare/universal-chat-provider-v0.7.0...universal-chat-provider-v0.7.1) (2026-06-17)


### Bug Fixes

* publish to marketplace with proposed apis allowed ([f17edee](https://github.com/maxdewald/universal-chat-provider/commit/f17edee0ab622b8b8f373e68012250f5788f2776))

## [0.7.0](https://github.com/maxdewald/universal-chat-provider/compare/universal-chat-provider-v0.6.0...universal-chat-provider-v0.7.0) (2026-06-17)


### Features

* add CLIProxyAPI model provider ([6236438](https://github.com/maxdewald/universal-chat-provider/commit/6236438b949ecdfd50204305d6327c2cf6e169b1))
* add new dependencies and refactor async handling with improved retry logic ([0882506](https://github.com/maxdewald/universal-chat-provider/commit/088250600900bc48ab7aeaab83f20f0dfaf3ab04))
* add prompt cache key and session affinity ([1f24de6](https://github.com/maxdewald/universal-chat-provider/commit/1f24de66f2b83f227fa4d3f63d1af96ff347a30c))
* add prompt cache metrics tracking and open settings command ([eab26a8](https://github.com/maxdewald/universal-chat-provider/commit/eab26a870b66f1f00afb48c1f12d6c47c8c4f359))
* add update suggestion feature and related tests ([906076e](https://github.com/maxdewald/universal-chat-provider/commit/906076ee12cdd76a50367a4bbce476382885ebdd))
* **chat:** introduce local token estimation and background caching ([480621b](https://github.com/maxdewald/universal-chat-provider/commit/480621b998b625a22fd3882e7c548554013a70ad))
* deduplicate reasoning models in mapping function and add corresponding test ([752cb28](https://github.com/maxdewald/universal-chat-provider/commit/752cb2860946c8000df33ccf9aad2f342437036e))
* improve commit message generation and server management UI ([a0c0650](https://github.com/maxdewald/universal-chat-provider/commit/a0c0650540c7d1e0bdbb319e420223805950f1d3))
* introduce managed server for CLIProxyAPI with health checks and port management; refactor provider to support universal chat; update tests and configurations accordingly ([9c1209a](https://github.com/maxdewald/universal-chat-provider/commit/9c1209aaafc369585ed662c27e26495fbe542201))
* **managed:** manage sidecar server lifecycle using window leases ([baa8537](https://github.com/maxdewald/universal-chat-provider/commit/baa85377f38e6017d3f130c22e6572ae4c5c97de))


### Bug Fixes

* **chat:** advertise full context window as maxInputTokens ([709b79b](https://github.com/maxdewald/universal-chat-provider/commit/709b79bce0d8c8baf4dcfa4d05dd13c0eab7a1ae))
* support VS Code 1.124 ([d5478fa](https://github.com/maxdewald/universal-chat-provider/commit/d5478fa3add5fc85c23b7ddf1345248d3700dcb1))


### Refactoring

* **chat:** use local token estimation instead of remote counting ([ef79f16](https://github.com/maxdewald/universal-chat-provider/commit/ef79f165e00e73bbb3fd54b29b44cad099e4cee1))
* enhance tooltip generation and improve model description handling ([0aece2b](https://github.com/maxdewald/universal-chat-provider/commit/0aece2bac4ee7f55cc2528312f5ef5a6334fd917))
* remove untildify dependency and update path handling for home directory expansion ([a8725c1](https://github.com/maxdewald/universal-chat-provider/commit/a8725c18a75e96180dcf4b5d87f55334dc33cb8a))
* resolve requested binary version dynamically ([9371ec9](https://github.com/maxdewald/universal-chat-provider/commit/9371ec9251f085619e2d415814e71887fac92e3c))
* simplify process exit tracking ([c7dd144](https://github.com/maxdewald/universal-chat-provider/commit/c7dd144e0c82242be1c2ce738cdfef8fc7e58e1c))
* update README to clarify utility model and remove commit messages section ([aa1ca96](https://github.com/maxdewald/universal-chat-provider/commit/aa1ca96beb783dc2a3f345f0f1133655d9e10f37))
