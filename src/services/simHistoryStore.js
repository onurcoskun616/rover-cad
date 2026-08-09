const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export function pushStep(sessionId, { code, kinematicsData, partsInline }) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { steps: [], currentStep: -1, createdAt: Date.now(), lastActivity: Date.now() };
    sessions.set(sessionId, session);
  }
  session.steps.length = session.currentStep + 1;
  session.steps.push({ code, kinematicsData, partsInline });
  session.currentStep = session.steps.length - 1;
  session.lastActivity = Date.now();
  return { stepIndex: session.currentStep, totalSteps: session.steps.length };
}

export function undoStep(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.currentStep <= 0) return null;
  session.currentStep -= 1;
  session.lastActivity = Date.now();
  const step = session.steps[session.currentStep];
  return {
    ...step,
    stepIndex: session.currentStep,
    totalSteps: session.steps.length,
  };
}

export function getSession(sessionId) {
  return sessions.get(sessionId) ?? null;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();
