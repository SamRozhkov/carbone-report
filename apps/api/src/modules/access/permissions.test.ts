import type { Role } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import { deleteRight, editRight, templateRights } from './permissions';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const user = (role: Role) => ({ id: ME, login: 'me', role });

/** Отношение пользователя к шаблону: ownerId шаблона и наличие в template_editors. */
const CASES = {
  владелец: { ownerId: ME, granted: false },
  выданный: { ownerId: OTHER, granted: true },
  чужой: { ownerId: OTHER, granted: false },
  'без владельца': { ownerId: null, granted: false },
} as const;
type Relation = keyof typeof CASES;

/** Ожидания §43.1–43.2: [правка, удаление]. */
const EXPECTED: Record<Role, Record<Relation, [boolean, boolean]>> = {
  admin: {
    владелец: [true, true],
    выданный: [true, true],
    чужой: [true, true],
    'без владельца': [true, true],
  },
  editor: {
    владелец: [true, true],
    выданный: [true, false],
    чужой: [false, false],
    'без владельца': [false, false],
  },
  access_manager: {
    владелец: [false, false],
    выданный: [false, false],
    чужой: [false, false],
    'без владельца': [false, false],
  },
  user: {
    владелец: [false, false],
    выданный: [false, false],
    чужой: [false, false],
    'без владельца': [false, false],
  },
};

describe('editRight / deleteRight (§43.1)', () => {
  for (const [role, byRelation] of Object.entries(EXPECTED) as [Role, typeof EXPECTED.admin][]) {
    for (const [relation, [edit, del]] of Object.entries(byRelation) as [
      Relation,
      [boolean, boolean],
    ][]) {
      it(`${role}, ${relation}: правка ${edit}, удаление ${del}`, () => {
        const { ownerId, granted } = CASES[relation];
        expect(editRight(user(role), { ownerId }, granted)).toBe(edit);
        expect(deleteRight(user(role), { ownerId })).toBe(del);
      });
    }
  }

  it('пониженный редактор не правит даже свой и выданный ему шаблон', () => {
    for (const role of ['access_manager', 'user'] as const)
      expect(editRight(user(role), { ownerId: ME }, true)).toBe(false);
  });
});

describe('templateRights', () => {
  it('удаление и список редакторов — у admin и владельца-editor', () => {
    expect(templateRights(user('admin'), { ownerId: null })).toEqual({
      canDelete: true,
      canManageEditors: true,
    });
    expect(templateRights(user('editor'), { ownerId: ME })).toEqual({
      canDelete: true,
      canManageEditors: true,
    });
    expect(templateRights(user('editor'), { ownerId: OTHER })).toEqual({
      canDelete: false,
      canManageEditors: false,
    });
  });
});
