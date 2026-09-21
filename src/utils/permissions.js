/* Permission catalogue. Roles are assembled from these strings.
   Format: "<module>:<action>" — the UI matrix maps one-to-one. */

export const MODULES = [
  'exam', 'question', 'schedule', 'invigilation',
  'evaluation', 'result', 'report', 'student', 'staff', 'role', 'ticket', 'settings',
];

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'publish'];

export const ALL_PERMISSIONS = MODULES.flatMap(m => ACTIONS.map(a => `${m}:${a}`));

const ROLE_SPECS = [
  { name: 'Administrator', scope: 'institution',
    description: 'Full control of the platform', permissions: ALL_PERMISSIONS },

  { name: 'Controller of Examinations', scope: 'institution',
    description: 'Oversight of every examination and result',
    permissions: [
      ...['exam','question','schedule','invigilation','evaluation','result','report','student','staff']
        .map(m => `${m}:view`),
      'result:approve', 'result:publish', 'evaluation:approve', 'exam:approve',
    ] },

  { name: 'Examination Coordinator', scope: 'institution',
    description: 'Creates, schedules and publishes examinations',
    permissions: [
      'exam:view','exam:create','exam:edit','exam:delete','exam:publish',
      'question:view','question:create','question:edit','question:delete',
      'schedule:view','schedule:create','schedule:edit','schedule:delete','schedule:publish',
      'invigilation:view','invigilation:edit',
      'evaluation:view','evaluation:edit','evaluation:approve',
      'result:view','result:edit','result:approve','result:publish',
      'report:view','student:view','staff:view','ticket:view','ticket:edit',
    ] },

  { name: 'Class Advisor', scope: 'own',
    description: 'Maintains the student roster for an assigned class',
    permissions: ['student:view','student:create','student:edit','exam:view','result:view','report:view'] },

  { name: 'Subject Staff', scope: 'own',
    description: 'Authors questions for mapped subjects',
    permissions: ['question:view','question:create','question:edit','question:delete',
                  'exam:view','student:view','result:view','report:view'] },

  { name: 'Invigilator', scope: 'own',
    description: 'Monitors an allocated room during an examination',
    permissions: ['invigilation:view','invigilation:edit','exam:view','student:view','ticket:view'] },

  { name: 'Evaluator', scope: 'own',
    description: 'Evaluates assigned answer scripts',
    permissions: ['evaluation:view','evaluation:edit','exam:view','result:view'] },
];

/* Every role defined here is a system role by definition. Marking
   them individually meant one flag was missed, the boot-time sync
   matched a single role, and a permission added in code never
   reached the database. */
export const SYSTEM_ROLES = ROLE_SPECS.map((r) => ({ ...r, isSystem: true }));

