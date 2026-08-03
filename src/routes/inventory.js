import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  listMachines,
  addMachine,
  updateMachine,
  removeMachine,
  listTools,
  addTool,
  updateTool,
  removeTool,
} from "../services/inventoryService.js";

// Build a CRUD router for one inventory collection (machines or tools). Every
// route is API-key protected, mirroring the rest of the backend.
function crudRouter({ list, add, update, remove, key }) {
  const router = Router();
  router.use(apiKeyAuth);

  router.get("/", (_req, res, next) => {
    try {
      res.json({ [key]: list() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", (req, res, next) => {
    try {
      const item = add(req.body ?? {});
      res.status(201).json({ [key.replace(/s$/, "")]: item });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put("/:id", (req, res, next) => {
    try {
      const item = update(req.params.id, req.body ?? {});
      if (!item) return res.status(404).json({ error: "Kayit bulunamadi" });
      res.json({ [key.replace(/s$/, "")]: item });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete("/:id", (req, res, next) => {
    try {
      const ok = remove(req.params.id);
      if (!ok) return res.status(404).json({ error: "Kayit bulunamadi" });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export const machinesRouter = crudRouter({
  list: listMachines,
  add: addMachine,
  update: updateMachine,
  remove: removeMachine,
  key: "machines",
});

export const toolsRouter = crudRouter({
  list: listTools,
  add: addTool,
  update: updateTool,
  remove: removeTool,
  key: "tools",
});
