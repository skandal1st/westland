# Evidence Context

Analysis target: Self-hosted installation and licensing boundary for AXIMA Commerce.

Source root inspected locally: `C:/code/Projects/westside`.

The repository currently has no resolvable `HEAD`; source drift is therefore unknown. The analysis is bound to this five-file collection:

| Evidence | Reader-facing title | Path | SHA-256 |
| --- | --- | --- | --- |
| E001 | Practical platform foundation | `docs/PLATFORM_FOUNDATION.md` | `aaa2782ac3fe3a4ad877f0d03e974910b3212c58f4da33a3ae08ee1f6379340a` |
| E002 | Earlier self-hosted AXIMA architecture | `docs/AXIMA_COMMERCE_ARCHITECTURE.md` | `90a68fc9fd17bc98f95570d982f7b6c66882194b7c413b87212f461a59de2026` |
| E003 | ERP extension contracts | `src/lib/integrations/contracts.ts` | `60cc73abff9f4f99340083c06254a5c4e7ae75789e793a1db4fe988d34fdc816` |
| E004 | Store-scoped commerce schema | `prisma/schema.prisma` | `0de24713b99b5eca536ecd3fb82fec03275cd50ba394e4aff1feb58cf6fbca7b` |
| E005 | Current runtime and scripts | `package.json` | `275c8ac46e57c42c9f3700ec7d65eb3a47c1655cf600f8b75acdb1ee6620b2c7` |

Collection SHA-256: `db3c8c413c23b859392785599d3af00e2e74106702ff44f9e2e2122d73c20072`.

User-supplied constraints, not source evidence:

- delivery is self-hosted rather than SaaS;
- an install script must collect initial settings, email configuration and enabled modules;
- a licensing server should discourage reuse by another buyer;
- protection should be proportionate and must acknowledge that a root-controlled full clone cannot be prevented absolutely.

