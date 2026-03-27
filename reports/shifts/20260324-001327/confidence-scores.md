# Confidence Scores

## Dish 001: Test Server Factory
| Input | Score | Rationale |
|-------|-------|-----------|
| specCompleteness | 5 | Concrete task, boundaries, acceptance criteria, existing E2E pattern to follow |
| verificationSpecificity | 4 | Explicit test file + typecheck, but pass/fail criteria are implicit |
| dependencyCertainty | 5 | No dependencies |
| complexityRisk | 3 | M-sized, cross-module but well-understood patterns |
| priorFailureRisk | 0 | No prior failures for this task type |
| providerFragilityRisk | 0 | Anthropic stable |

- clarityScore = round(((5*0.4 + 4*0.35 + 5*0.25) / 5) * 100) = round(((2.0+1.4+1.25)/5)*100) = round(93) = 93
- riskScore = round(((3*0.45 + 0*0.35 + 0*0.20) / 5) * 100) = round(27) = 27
- confidenceScore = round(93 - (27 * 0.6)) = round(93 - 16.2) = 77
- **Band A** (77 >= 60, 27 < 55) → dispatchPriority: high

## Dish 002: Mock Runner Client
| Input | Score | Rationale |
|-------|-------|-----------|
| specCompleteness | 4 | Clear spec, builder pattern outlined, some edge cases implicit |
| verificationSpecificity | 4 | Explicit test scenarios listed |
| dependencyCertainty | 5 | Single dep on 001, well-justified |
| complexityRisk | 2 | Single file, moderate Socket.IO complexity |
| priorFailureRisk | 0 | No prior |
| providerFragilityRisk | 0 | Anthropic stable |

- clarityScore = round(((4*0.4 + 4*0.35 + 5*0.25) / 5) * 100) = round(((1.6+1.4+1.25)/5)*100) = round(85) = 85
- riskScore = round(((2*0.45 + 0*0.35 + 0*0.20) / 5) * 100) = round(18) = 18
- confidenceScore = round(85 - (18 * 0.6)) = round(85 - 10.8) = 74
- **Band A** (74 >= 60, 18 < 55) → dispatchPriority: high

## Dish 003: Mock Session & Conversation Builders
| Input | Score | Rationale |
|-------|-------|-----------|
| specCompleteness | 5 | Detailed builder functions, shapes from protocol |
| verificationSpecificity | 4 | Test scenarios explicit |
| dependencyCertainty | 5 | Single dep on 001 |
| complexityRisk | 2 | Pure functions + one Socket.IO client |
| priorFailureRisk | 0 | No prior |
| providerFragilityRisk | 0 | Anthropic stable |

- clarityScore = round(((5*0.4 + 4*0.35 + 5*0.25) / 5) * 100) = 93
- riskScore = round(((2*0.45 + 0*0.35 + 0*0.20) / 5) * 100) = 18
- confidenceScore = round(93 - (18 * 0.6)) = 82
- **Band A** (82 >= 60, 18 < 55) → dispatchPriority: high

## Dish 004: Mock Viewer Client
| Input | Score | Rationale |
|-------|-------|-----------|
| specCompleteness | 4 | Clear spec, viewer/hub patterns documented |
| verificationSpecificity | 4 | Explicit test scenarios |
| dependencyCertainty | 5 | Single dep on 001 |
| complexityRisk | 2 | Two Socket.IO clients, moderate complexity |
| priorFailureRisk | 0 | No prior |
| providerFragilityRisk | 0 | Anthropic stable |

- clarityScore = round(((4*0.4 + 4*0.35 + 5*0.25) / 5) * 100) = 85
- riskScore = round(((2*0.45 + 0*0.35 + 0*0.20) / 5) * 100) = 18
- confidenceScore = round(85 - (18 * 0.6)) = 74
- **Band A** (74 >= 60, 18 < 55) → dispatchPriority: normal (upgrade to high since parallel with 002/003)

## Dish 005: BDD Scenario Helpers & Integration Tests
| Input | Score | Rationale |
|-------|-------|-----------|
| specCompleteness | 4 | Good spec but integration test details depend on actual implementations from 001-004 |
| verificationSpecificity | 3 | Generic "tests pass" — specific assertions depend on runtime behavior |
| dependencyCertainty | 4 | Four deps, all well-justified but complex DAG |
| complexityRisk | 3 | Composing 4 modules, async coordination |
| priorFailureRisk | 0 | No prior |
| providerFragilityRisk | 0 | Anthropic stable |

- clarityScore = round(((4*0.4 + 3*0.35 + 4*0.25) / 5) * 100) = round(((1.6+1.05+1.0)/5)*100) = round(73) = 73
- riskScore = round(((3*0.45 + 0*0.35 + 0*0.20) / 5) * 100) = 27
- confidenceScore = round(73 - (27 * 0.6)) = round(73 - 16.2) = 57
- **Band B** (30 <= 57 < 60, 27 < 70) → dispatchPriority: normal

## Dish 006: Documentation
| Input | Score | Rationale |
|-------|-------|-----------|
| specCompleteness | 4 | Clear outline of what to document |
| verificationSpecificity | 2 | "Review README" is subjective |
| dependencyCertainty | 5 | Single dep on 005 |
| complexityRisk | 1 | S-sized, single file |
| priorFailureRisk | 0 | No prior |
| providerFragilityRisk | 0 | Anthropic stable |

- clarityScore = round(((4*0.4 + 2*0.35 + 5*0.25) / 5) * 100) = round(((1.6+0.7+1.25)/5)*100) = round(71) = 71
- riskScore = round(((1*0.45 + 0*0.35 + 0*0.20) / 5) * 100) = round(9) = 9
- confidenceScore = round(71 - (9 * 0.6)) = round(71 - 5.4) = 66
- **Band A** (66 >= 60, 9 < 55) → dispatchPriority: normal
