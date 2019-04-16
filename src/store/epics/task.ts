import { empty, from, forkJoin, timer } from 'rxjs';
import {
  mergeMap,
  map,
  takeUntil,
  filter,
  mapTo,
  tap,
  debounce,
  groupBy,
  takeWhile,
  switchMap
} from 'rxjs/operators';
import { ofType, Epic } from 'redux-observable';
import { tasks_v1 } from 'googleapis';
import {
  TaskActions,
  TaskActionTypes,
  AddTaskSuccess,
  UpdateTask,
  UpdateTaskSuccess
} from '../actions/task';
import { RootState } from '../reducers';
import { tasksAPI } from '../../api';
import { EpicDependencies } from '../epicDependencies';
import merge from 'lodash/merge';

const deleteTaskSuccess$ = (tasklist: string, task?: string) =>
  from(tasksAPI.delete({ tasklist, task })).pipe(
    map<any, TaskActions>(() => ({
      type: TaskActionTypes.DELETE_TASK_SUCCESS
    }))
  );

const updateTaskSuccess$ = (params: UpdateTask['payload']) => {
  delete params.requestBody.completed;
  return from(tasksAPI.update(params).then(({ data }) => data)).pipe(
    map<tasks_v1.Schema$Task, UpdateTaskSuccess>(payload => ({
      type: TaskActionTypes.UPDATE_TASK_SUCCESS,
      payload
    }))
  );
};

const apiEpic: Epic<TaskActions, TaskActions, RootState, EpicDependencies> = (
  action$,
  state$,
  { nprogress }
) =>
  action$.pipe(
    filter(action => !/Update/i.test(action.type)),
    mergeMap(action => {
      if (!state$.value.auth.loggedIn) {
        return empty();
      }

      const tasklist = state$.value.taskList.currentTaskListId;

      switch (action.type) {
        case TaskActionTypes.GET_ALL_TASKS:
          nprogress.inc(0.4);

          return from(tasksAPI.list(action.payload)).pipe(
            tap(() => nprogress.done()),
            map(({ data }) => data),
            map<tasks_v1.Schema$Tasks, TaskActions>(({ items }) => ({
              type: TaskActionTypes.GET_ALL_TASKS_SUCCESS,
              payload: items || []
            })),
            takeUntil(action$.pipe(ofType(TaskActionTypes.GET_ALL_TASKS)))
          );

        case TaskActionTypes.ADD_TASK:
          return from(tasksAPI.insert(action.payload.params)).pipe(
            map(({ data }) => data),
            map<tasks_v1.Schema$Task, TaskActions>(task => ({
              type: TaskActionTypes.ADD_TASK_SUCCESS,
              payload: {
                task,
                uuid: action.payload.uuid
              }
            }))
          );

        case TaskActionTypes.DELETE_TASK:
          if (!action.payload.task) {
            return action$.pipe(
              ofType<TaskActions, AddTaskSuccess>(
                TaskActionTypes.ADD_TASK_SUCCESS
              ),
              takeWhile(
                success =>
                  success.payload.uuid === action.payload.requestBody.uuid
              ),
              mergeMap(success =>
                deleteTaskSuccess$(
                  action.payload.tasklist,
                  success.payload.task.id!
                )
              )
            );
          }

          return deleteTaskSuccess$(
            action.payload.tasklist,
            action.payload.task
          );

        case TaskActionTypes.DELETE_COMPLETED_TASKS:
          return forkJoin(
            ...action.payload.map(task => deleteTaskSuccess$(tasklist, task.id))
          ).pipe(
            mapTo<any, TaskActions>({
              type: TaskActionTypes.DELETE_COMPLETED_TASKS_SUCCESS
            })
          );

        default:
          return empty();
      }
    })
  );

// FIXME:
const updateEpic: Epic<TaskActions, TaskActions, RootState> = (
  action$,
  state$
) => {
  return action$.pipe(
    ofType<TaskActions, UpdateTask>(TaskActionTypes.UPDATE_TASK),
    groupBy(action => action.payload.requestBody.uuid),
    mergeMap(group$ => {
      return group$.pipe(
        debounce(action => timer(action.payload.task ? 1000 : 0)),
        switchMap(action => {
          // FIXME: make this better
          if (
            !state$.value.task.tasks.find(
              task => task.uuid === action.payload.requestBody.uuid
            )
          ) {
            return empty();
          }

          if (action.payload.task === undefined) {
            return action$.pipe(
              ofType<TaskActions, AddTaskSuccess>(
                TaskActionTypes.ADD_TASK_SUCCESS
              ),
              takeWhile(
                success =>
                  success.payload.uuid === action.payload.requestBody.uuid
              ),
              mergeMap(success => {
                return updateTaskSuccess$({
                  tasklist: action.payload.tasklist,
                  task: success.payload.task.id,
                  requestBody: merge(
                    success.payload.task,
                    action.payload.requestBody
                  )
                });
              })
            );
          }

          return updateTaskSuccess$(action.payload);
        })
      );
    })
  );
};

export default [apiEpic, updateEpic];
