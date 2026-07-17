# tickets

## 0.3.0

### Minor Changes

- [#24](https://github.com/eli0shin/tickets/pull/24) [`bbc914c`](https://github.com/eli0shin/tickets/commit/bbc914c79102ea3f6e5bb883f930066a63b9709b) Thanks [@eli0shin](https://github.com/eli0shin)! - Add explicit native self-updates plus the complete automatic update lifecycle with persisted checks, silent installation, notifications, configurable intervals, and opt-out behavior.

### Patch Changes

- [#29](https://github.com/eli0shin/tickets/pull/29) [`5326c3d`](https://github.com/eli0shin/tickets/commit/5326c3df205450c9ab25ad9621ed8dc78f962ed8) Thanks [@eli0shin](https://github.com/eli0shin)! - Print the resolved absolute ticket path before the complete document in `tickets show` output.

- [#26](https://github.com/eli0shin/tickets/pull/26) [`8fa54e7`](https://github.com/eli0shin/tickets/commit/8fa54e7f76d55094f028ed39852c8c40a9a4bcba) Thanks [@eli0shin](https://github.com/eli0shin)! - Scope status-filtered searches before parsing tickets and treat repeated status filters as a union.

- [#27](https://github.com/eli0shin/tickets/pull/27) [`883c86d`](https://github.com/eli0shin/tickets/commit/883c86d7f81720c225b65eff758e786a9d4c6763) Thanks [@eli0shin](https://github.com/eli0shin)! - Accept and exactly preserve human assignee names in ticket creation, search, and lint.

- [#25](https://github.com/eli0shin/tickets/pull/25) [`7a44647`](https://github.com/eli0shin/tickets/commit/7a4464784874a6a598e66874031008aac58c7aa5) Thanks [@eli0shin](https://github.com/eli0shin)! - Accept human-readable ticket descriptions in create and rename commands by normalizing them to deterministic lowercase kebab-case filenames.

## 0.2.0

### Minor Changes

- [#7](https://github.com/eli0shin/tickets/pull/7) [`dcf4a62`](https://github.com/eli0shin/tickets/commit/dcf4a62e6553ff18238e099c1b79d2a16635617a) Thanks [@eli0shin](https://github.com/eli0shin)! - Add project, status, and ticket creation through the tracker and CLI.

- [#1](https://github.com/eli0shin/tickets/pull/1) [`dc8b248`](https://github.com/eli0shin/tickets/commit/dc8b2482f56a00110219b6f9bd6a686e578d5d75) Thanks [@eli0shin](https://github.com/eli0shin)! - Bootstrap the Bun and TypeScript command-line application.

- [#2](https://github.com/eli0shin/tickets/pull/2) [`acba3f6`](https://github.com/eli0shin/tickets/commit/acba3f6165b19911144c0cacab17815a2b14360a) Thanks [@eli0shin](https://github.com/eli0shin)! - Add the bundled Tickets agent skill and its installation command.

- [#5](https://github.com/eli0shin/tickets/pull/5) [`8eccb37`](https://github.com/eli0shin/tickets/commit/8eccb37364a242b95c7dfa6a1b6e80456f147840) Thanks [@eli0shin](https://github.com/eli0shin)! - Add read-only selected-project lint with stable plain-text and JSON findings.

- [#8](https://github.com/eli0shin/tickets/pull/8) [`70ab3e5`](https://github.com/eli0shin/tickets/commit/70ab3e55ee2e261896c44e5af7fdd2e8d064419c) Thanks [@eli0shin](https://github.com/eli0shin)! - Add ticket rename, move, and idempotent completion with workspace-wide reference cleanup.

- [#6](https://github.com/eli0shin/tickets/pull/6) [`c521dd3`](https://github.com/eli0shin/tickets/commit/c521dd310633f607a98bdfad45697ec4525fd20e) Thanks [@eli0shin](https://github.com/eli0shin)! - Add project and status listings plus ticket show, list, and structured search commands.

- [#4](https://github.com/eli0shin/tickets/pull/4) [`25a2059`](https://github.com/eli0shin/tickets/commit/25a2059fbee0b5e53ee9cef7eef323fccfcb7008) Thanks [@eli0shin](https://github.com/eli0shin)! - Add explicit and Git-origin-based project selection.

- [#3](https://github.com/eli0shin/tickets/pull/3) [`be7bd09`](https://github.com/eli0shin/tickets/commit/be7bd094b3400fd0a07ff6c16400dbc9e6f05007) Thanks [@eli0shin](https://github.com/eli0shin)! - Add the filesystem tracker foundation for discovery, document parsing, and canonical writes.

### Patch Changes

- [#14](https://github.com/eli0shin/tickets/pull/14) [`921b84b`](https://github.com/eli0shin/tickets/commit/921b84be0abc4e2086a4d114f44cca9a98a266b8) Thanks [@eli0shin](https://github.com/eli0shin)! - Route all CLI and interactive prompt output through the shared output boundary.

- [#13](https://github.com/eli0shin/tickets/pull/13) [`bc0a4d8`](https://github.com/eli0shin/tickets/commit/bc0a4d8b93c47f78cc5ee6acc7cea32b784cce2e) Thanks [@eli0shin](https://github.com/eli0shin)! - Remove product-specific symbolic-link handling from tracker discovery and lint.

- [#9](https://github.com/eli0shin/tickets/pull/9) [`b723fca`](https://github.com/eli0shin/tickets/commit/b723fcaed0e7cf8314cf2987d2ddb7c445c9f2f8) Thanks [@eli0shin](https://github.com/eli0shin)! - Ship native release artifacts and a binary-only installer for supported Linux and macOS systems.

- [#22](https://github.com/eli0shin/tickets/pull/22) [`8ed8b6b`](https://github.com/eli0shin/tickets/commit/8ed8b6bd82a3a7e9472c59c7e211b96566db581a) Thanks [@eli0shin](https://github.com/eli0shin)! - Preserve parser-supported YAML metadata during relationship rewrites.

- [#11](https://github.com/eli0shin/tickets/pull/11) [`a45161d`](https://github.com/eli0shin/tickets/commit/a45161dc1cf0e8802f4c12887a72ec397402afbc) Thanks [@eli0shin](https://github.com/eli0shin)! - Remove hidden ticket creation locking while preserving discovered-ID allocation and create-only publication.

- [#19](https://github.com/eli0shin/tickets/pull/19) [`2832e27`](https://github.com/eli0shin/tickets/commit/2832e27de2f74d7dfbae96775b327a8f90d79ba3) Thanks [@eli0shin](https://github.com/eli0shin)! - Render unexpected command and skill-confirmation failures as one-line CLI diagnostics with exit status 2.

- [#17](https://github.com/eli0shin/tickets/pull/17) [`7382cd4`](https://github.com/eli0shin/tickets/commit/7382cd4c2c67a8d26c97e78a159422568caf46b0) Thanks [@eli0shin](https://github.com/eli0shin)! - Restore the accepted CLI, command orchestration, and output module boundaries without changing command behavior.

- [#12](https://github.com/eli0shin/tickets/pull/12) [`0855f00`](https://github.com/eli0shin/tickets/commit/0855f00c0ba27bfdb2cce0197958df6e33fea485) Thanks [@eli0shin](https://github.com/eli0shin)! - Restore Commander's standard `-V, --version` interface and remove the lowercase `-v` alias.
