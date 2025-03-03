import {
    AlreadyExistsError,
    CreateDbtCloudIntegration,
    CreateProject,
    CreateWarehouseCredentials,
    DbtCloudIntegration,
    DbtProjectConfig,
    Explore,
    ExploreError,
    NotExistsError,
    OrganizationProject,
    PreviewContentMapping,
    Project,
    ProjectMemberProfile,
    ProjectMemberRole,
    ProjectType,
    sensitiveCredentialsFieldNames,
    sensitiveDbtCredentialsFieldNames,
    TablesConfiguration,
    UnexpectedServerError,
    UpdateProject,
    WarehouseCredentials,
} from '@lightdash/common';
import {
    WarehouseCatalog,
    warehouseClientFromCredentials,
} from '@lightdash/warehouses';
import { Knex } from 'knex';
import { DatabaseError } from 'pg';
import { LightdashConfig } from '../../config/parseConfig';
import { DbDashboard } from '../../database/entities/dashboards';
import { OrganizationTableName } from '../../database/entities/organizations';
import { PinnedListTableName } from '../../database/entities/pinnedList';
import { DbProjectMembership } from '../../database/entities/projectMemberships';
import {
    CachedExploresTableName,
    CachedWarehouseTableName,
    DbCachedExplores,
    DbCachedWarehouse,
    DbProject,
    ProjectTableName,
} from '../../database/entities/projects';
import { DbSavedChart } from '../../database/entities/savedCharts';
import { DbUser } from '../../database/entities/users';
import { WarehouseCredentialTableName } from '../../database/entities/warehouseCredentials';
import Logger from '../../logger';
import { EncryptionService } from '../../services/EncryptionService/EncryptionService';
import Transaction = Knex.Transaction;

type ProjectModelDependencies = {
    database: Knex;
    lightdashConfig: LightdashConfig;
    encryptionService: EncryptionService;
};

const CACHED_EXPLORES_PG_LOCK_NAMESPACE = 1;

export class ProjectModel {
    private database: Knex;

    private lightdashConfig: LightdashConfig;

    private encryptionService: EncryptionService;

    constructor(deps: ProjectModelDependencies) {
        this.database = deps.database;
        this.lightdashConfig = deps.lightdashConfig;
        this.encryptionService = deps.encryptionService;
    }

    static mergeMissingDbtConfigSecrets(
        incompleteConfig: DbtProjectConfig,
        completeConfig: DbtProjectConfig,
    ): DbtProjectConfig {
        if (incompleteConfig.type !== completeConfig.type) {
            return incompleteConfig;
        }
        return {
            ...incompleteConfig,
            ...sensitiveDbtCredentialsFieldNames.reduce(
                (sum, secretKey) =>
                    !(incompleteConfig as any)[secretKey] &&
                    (completeConfig as any)[secretKey]
                        ? {
                              ...sum,
                              [secretKey]: (completeConfig as any)[secretKey],
                          }
                        : sum,
                {},
            ),
        };
    }

    static mergeMissingWarehouseSecrets(
        incompleteConfig: CreateWarehouseCredentials,
        completeConfig: CreateWarehouseCredentials,
    ): CreateWarehouseCredentials {
        if (incompleteConfig.type !== completeConfig.type) {
            return incompleteConfig;
        }
        return {
            ...incompleteConfig,
            ...sensitiveCredentialsFieldNames.reduce(
                (sum, secretKey) =>
                    !(incompleteConfig as any)[secretKey] &&
                    (completeConfig as any)[secretKey]
                        ? {
                              ...sum,
                              [secretKey]: (completeConfig as any)[secretKey],
                          }
                        : sum,
                {},
            ),
        };
    }

    static mergeMissingProjectConfigSecrets(
        incompleteProjectConfig: UpdateProject,
        completeProjectConfig: Project & {
            warehouseConnection?: CreateWarehouseCredentials;
        },
    ): UpdateProject {
        return {
            ...incompleteProjectConfig,
            dbtConnection: ProjectModel.mergeMissingDbtConfigSecrets(
                incompleteProjectConfig.dbtConnection,
                completeProjectConfig.dbtConnection,
            ),
            warehouseConnection: completeProjectConfig.warehouseConnection
                ? ProjectModel.mergeMissingWarehouseSecrets(
                      incompleteProjectConfig.warehouseConnection,
                      completeProjectConfig.warehouseConnection,
                  )
                : incompleteProjectConfig.warehouseConnection,
        };
    }

    async getAllByOrganizationUuid(
        organizationUuid: string,
    ): Promise<OrganizationProject[]> {
        const orgs = await this.database('organizations')
            .where('organization_uuid', organizationUuid)
            .select('*');
        if (orgs.length === 0) {
            throw new NotExistsError('Cannot find organization');
        }
        const projects = await this.database('projects')
            .select('project_uuid', 'name', 'project_type')
            .where('organization_id', orgs[0].organization_id);

        return projects.map<OrganizationProject>(
            ({ name, project_uuid, project_type }) => ({
                name,
                projectUuid: project_uuid,
                type: project_type,
            }),
        );
    }

    private async upsertWarehouseConnection(
        trx: Transaction,
        projectId: number,
        data: CreateWarehouseCredentials,
    ): Promise<void> {
        let encryptedCredentials: Buffer;
        try {
            encryptedCredentials = this.encryptionService.encrypt(
                JSON.stringify(data),
            );
        } catch (e) {
            throw new UnexpectedServerError('Could not save credentials.');
        }
        await trx('warehouse_credentials')
            .insert({
                project_id: projectId,
                warehouse_type: data.type,
                encrypted_credentials: encryptedCredentials,
            })
            .onConflict('project_id')
            .merge();
    }

    async hasProjects(organizationUuid: string): Promise<boolean> {
        const orgs = await this.database('organizations')
            .where('organization_uuid', organizationUuid)
            .select('*');
        if (orgs.length === 0) {
            throw new NotExistsError('Cannot find organization');
        }

        const projects = await this.database('projects')
            .where('organization_id', orgs[0].organization_id)
            .select('project_uuid');
        return projects.length > 0;
    }

    async create(
        organizationUuid: string,
        data: CreateProject,
    ): Promise<string> {
        const orgs = await this.database('organizations')
            .where('organization_uuid', organizationUuid)
            .select('*');
        if (orgs.length === 0) {
            throw new NotExistsError('Cannot find organization');
        }
        return this.database.transaction(async (trx) => {
            let encryptedCredentials: Buffer;
            try {
                encryptedCredentials = this.encryptionService.encrypt(
                    JSON.stringify(data.dbtConnection),
                );
            } catch (e) {
                throw new UnexpectedServerError('Could not save credentials.');
            }

            // Make sure the project to copy exists and is owned by the same organization
            const copiedProjects = data.copiedFromProjectUuid
                ? await trx('projects')
                      .where('organization_id', orgs[0].organization_id)
                      .andWhere('project_uuid', data.copiedFromProjectUuid)
                : [];
            const [project] = await trx('projects')
                .insert({
                    name: data.name,
                    project_type: data.type,
                    organization_id: orgs[0].organization_id,
                    dbt_connection_type: data.dbtConnection.type,
                    dbt_connection: encryptedCredentials,
                    copied_from_project_uuid:
                        copiedProjects.length === 1
                            ? copiedProjects[0].project_uuid
                            : null,
                })
                .returning('*');

            await this.upsertWarehouseConnection(
                trx,
                project.project_id,
                data.warehouseConnection,
            );

            await trx('spaces').insert({
                project_id: project.project_id,
                name: 'Shared',
                is_private: false,
            });

            return project.project_uuid;
        });
    }

    async update(projectUuid: string, data: UpdateProject): Promise<void> {
        await this.database.transaction(async (trx) => {
            let encryptedCredentials: Buffer;
            try {
                encryptedCredentials = this.encryptionService.encrypt(
                    JSON.stringify(data.dbtConnection),
                );
            } catch (e) {
                throw new UnexpectedServerError('Could not save credentials.');
            }
            const projects = await trx('projects')
                .update({
                    name: data.name,
                    dbt_connection_type: data.dbtConnection.type,
                    dbt_connection: encryptedCredentials,
                })
                .where('project_uuid', projectUuid)
                .returning('*');
            if (projects.length === 0) {
                throw new UnexpectedServerError('Could not update project.');
            }
            const [project] = projects;

            await this.upsertWarehouseConnection(
                trx,
                project.project_id,
                data.warehouseConnection,
            );
        });
    }

    async delete(projectUuid: string): Promise<void> {
        await this.database('projects')
            .where('project_uuid', projectUuid)
            .delete();
    }

    async getWithSensitiveFields(
        projectUuid: string,
    ): Promise<Project & { warehouseConnection?: CreateWarehouseCredentials }> {
        type QueryResult = (
            | {
                  name: string;
                  project_type: ProjectType;
                  dbt_connection: Buffer | null;
                  encrypted_credentials: null;
                  warehouse_type: null;
                  organization_uuid: string;
                  pinned_list_uuid?: string;
              }
            | {
                  name: string;
                  project_type: ProjectType;
                  dbt_connection: Buffer | null;
                  encrypted_credentials: Buffer;
                  warehouse_type: string;
                  organization_uuid: string;
                  pinned_list_uuid?: string;
              }
        )[];
        const projects = await this.database('projects')
            .leftJoin(
                WarehouseCredentialTableName,
                'warehouse_credentials.project_id',
                'projects.project_id',
            )
            .leftJoin(
                OrganizationTableName,
                'organizations.organization_id',
                'projects.organization_id',
            )
            .leftJoin(
                PinnedListTableName,
                'pinned_list.project_uuid',
                'projects.project_uuid',
            )
            .column([
                this.database.ref('name').withSchema(ProjectTableName),
                this.database.ref('project_type').withSchema(ProjectTableName),
                this.database
                    .ref('dbt_connection')
                    .withSchema(ProjectTableName),
                this.database
                    .ref('encrypted_credentials')
                    .withSchema(WarehouseCredentialTableName),
                this.database
                    .ref('warehouse_type')
                    .withSchema(WarehouseCredentialTableName),
                this.database
                    .ref('organization_uuid')
                    .withSchema(OrganizationTableName),
                this.database
                    .ref('pinned_list_uuid')
                    .withSchema(PinnedListTableName),
            ])
            .select<QueryResult>()
            .where('projects.project_uuid', projectUuid);
        if (projects.length === 0) {
            throw new NotExistsError(
                `Cannot find project with id: ${projectUuid}`,
            );
        }
        const [project] = projects;
        if (!project.dbt_connection) {
            throw new NotExistsError('Project has no valid dbt credentials');
        }
        let dbtSensitiveCredentials: DbtProjectConfig;
        try {
            dbtSensitiveCredentials = JSON.parse(
                this.encryptionService.decrypt(project.dbt_connection),
            ) as DbtProjectConfig;
        } catch (e) {
            throw new UnexpectedServerError('Failed to load dbt credentials');
        }
        const result: Omit<Project, 'warehouseConnection'> = {
            organizationUuid: project.organization_uuid,
            projectUuid,
            name: project.name,
            type: project.project_type,
            dbtConnection: dbtSensitiveCredentials,
            pinnedListUuid: project.pinned_list_uuid,
        };
        if (!project.warehouse_type) {
            return result;
        }
        let sensitiveCredentials: CreateWarehouseCredentials;
        try {
            sensitiveCredentials = JSON.parse(
                this.encryptionService.decrypt(project.encrypted_credentials),
            ) as CreateWarehouseCredentials;
        } catch (e) {
            throw new UnexpectedServerError(
                'Failed to load warehouse credentials',
            );
        }
        return {
            ...result,
            warehouseConnection: sensitiveCredentials,
        };
    }

    async get(projectUuid: string): Promise<Project> {
        const project = await this.getWithSensitiveFields(projectUuid);
        const sensitiveCredentials = project.warehouseConnection;

        const nonSensitiveDbtCredentials = Object.fromEntries(
            Object.entries(project.dbtConnection).filter(
                ([key]) =>
                    !sensitiveDbtCredentialsFieldNames.includes(key as any),
            ),
        ) as DbtProjectConfig;
        const nonSensitiveCredentials = sensitiveCredentials
            ? (Object.fromEntries(
                  Object.entries(sensitiveCredentials).filter(
                      ([key]) =>
                          !sensitiveCredentialsFieldNames.includes(key as any),
                  ),
              ) as WarehouseCredentials)
            : undefined;
        return {
            organizationUuid: project.organizationUuid,
            projectUuid,
            name: project.name,
            type: project.type,
            dbtConnection: nonSensitiveDbtCredentials,
            warehouseConnection: nonSensitiveCredentials,
            pinnedListUuid: project.pinnedListUuid,
        };
    }

    async getTablesConfiguration(
        projectUuid: string,
    ): Promise<TablesConfiguration> {
        const projects = await this.database(ProjectTableName)
            .select(['table_selection_type', 'table_selection_value'])
            .where('project_uuid', projectUuid);
        if (projects.length === 0) {
            throw new NotExistsError(
                `Cannot find project with id: ${projectUuid}`,
            );
        }
        return {
            tableSelection: {
                type: projects[0].table_selection_type,
                value: projects[0].table_selection_value,
            },
        };
    }

    async updateTablesConfiguration(
        projectUuid: string,
        data: TablesConfiguration,
    ): Promise<void> {
        await this.database(ProjectTableName)
            .update({
                table_selection_type: data.tableSelection.type,
                table_selection_value: data.tableSelection.value,
            })
            .where('project_uuid', projectUuid);
    }

    async getExploresFromCache(
        projectUuid: string,
    ): Promise<(Explore | ExploreError)[] | undefined> {
        const explores = await this.database(CachedExploresTableName)
            .select(['explores'])
            .where('project_uuid', projectUuid)
            .limit(1);
        if (explores.length > 0) return explores[0].explores;
        return undefined;
    }

    static convertMetricFiltersFieldIdsToFieldRef = (explore: Explore) => {
        const convertedExplore = { ...explore };
        if (convertedExplore.tables) {
            Object.values(convertedExplore.tables).forEach((table) => {
                if (table.metrics) {
                    Object.values(table.metrics).forEach((metric) => {
                        if (metric.filters) {
                            metric.filters.forEach((filter) => {
                                // @ts-expect-error cached explore types might not be up to date
                                const { fieldId, fieldRef, ...rest } =
                                    filter.target;
                                // eslint-disable-next-line no-param-reassign
                                filter.target = {
                                    ...rest,
                                    fieldRef: fieldRef ?? fieldId,
                                };
                            });
                        }
                    });
                }
            });
        }

        return convertedExplore;
    };

    async getExploreFromCache(
        projectUuid: string,
        exploreName: string,
    ): Promise<Explore | ExploreError> {
        const [row] = await this.database('cached_explores')
            .select<{ explore: Explore | ExploreError }[]>(['explore'])
            .crossJoin(
                this.database.raw('jsonb_array_elements(explores) as explore'),
            )
            .where('project_uuid', projectUuid)
            .andWhereRaw(
                this.database.raw("explore->>'name' = ?", [exploreName]),
            );
        if (row === undefined) {
            throw new NotExistsError(
                `Explore "${exploreName}" does not exist.`,
            );
        }

        const exploreFromCache: Explore =
            ProjectModel.convertMetricFiltersFieldIdsToFieldRef(row.explore);

        return exploreFromCache;
    }

    async saveExploresToCache(
        projectUuid: string,
        explores: (Explore | ExploreError)[],
    ): Promise<DbCachedExplores> {
        const [cachedExplores] = await this.database(CachedExploresTableName)
            .insert({
                project_uuid: projectUuid,
                explores: JSON.stringify(explores),
            })
            .onConflict('project_uuid')
            .merge()
            .returning('*');
        return cachedExplores;
    }

    async tryAcquireProjectLock(
        projectUuid: string,
        onLockAcquired: () => Promise<void>,
        onLockFailed?: () => Promise<void>,
    ): Promise<void> {
        await this.database.transaction(async (trx) => {
            // pg_advisory_xact_lock takes a 64bit integer as key
            // we can't use project_uuid (uuidv4) as key, not even a hash,
            // so we will be using autoinc project_id from DB.
            const projectLock = await trx.raw(`
                SELECT
                    pg_try_advisory_xact_lock(${CACHED_EXPLORES_PG_LOCK_NAMESPACE}, project_id)
                FROM
                    projects
                WHERE
                    project_uuid = '${projectUuid}'
                LIMIT 1  `);

            if (projectLock.rows.length === 0) return; // No project with uuid in DB
            const acquiresLock = projectLock.rows[0].pg_try_advisory_xact_lock;
            if (acquiresLock) {
                await onLockAcquired();
            } else if (onLockFailed) {
                await onLockFailed();
            }
        });
    }

    async getWarehouseFromCache(
        projectUuid: string,
    ): Promise<WarehouseCatalog | undefined> {
        const warehouses = await this.database(CachedWarehouseTableName)
            .select(['warehouse'])
            .where('project_uuid', projectUuid)
            .limit(1);
        if (warehouses.length > 0) return warehouses[0].warehouse;
        return undefined;
    }

    async saveWarehouseToCache(
        projectUuid: string,
        warehouse: WarehouseCatalog,
    ): Promise<DbCachedWarehouse> {
        const [cachedWarehouse] = await this.database(CachedWarehouseTableName)
            .insert({
                project_uuid: projectUuid,
                warehouse: JSON.stringify(warehouse),
            })
            .onConflict('project_uuid')
            .merge()
            .returning('*');

        return cachedWarehouse;
    }

    async getProjectAccess(
        projectUuid: string,
    ): Promise<ProjectMemberProfile[]> {
        type QueryResult = {
            user_uuid: string;
            email: string;
            role: ProjectMemberRole;
            first_name: string;
            last_name: string;
        };
        const projectMemberships = await this.database('project_memberships')
            .leftJoin('users', 'project_memberships.user_id', 'users.user_id')
            .leftJoin('emails', 'emails.user_id', 'users.user_id')
            .leftJoin(
                'projects',
                'project_memberships.project_id',
                'projects.project_id',
            )
            .select<QueryResult[]>()
            .where('project_uuid', projectUuid)
            .andWhere('is_primary', true);

        return projectMemberships.map((membership) => ({
            userUuid: membership.user_uuid,
            email: membership.email,
            role: membership.role,
            firstName: membership.first_name,
            projectUuid,
            lastName: membership.last_name,
        }));
    }

    async createProjectAccess(
        projectUuid: string,
        email: string,
        role: ProjectMemberRole,
    ): Promise<void> {
        try {
            const [project] = await this.database('projects')
                .select('project_id')
                .where('project_uuid', projectUuid);

            const [user] = await this.database('users')
                .leftJoin('emails', 'emails.user_id', 'users.user_id')
                .select('users.user_id')
                .where('email', email);
            if (user === undefined) {
                throw new NotExistsError(
                    `Can't find user with email ${email} in the organization`,
                );
            }
            await this.database('project_memberships').insert({
                project_id: project.project_id,
                role,
                user_id: user.user_id,
            });
        } catch (error: any) {
            if (
                error instanceof DatabaseError &&
                error.constraint ===
                    'project_memberships_project_id_user_id_unique'
            ) {
                throw new AlreadyExistsError(
                    `This user email ${email} already has access to this project`,
                );
            }
            throw error;
        }
    }

    async updateProjectAccess(
        projectUuid: string,
        userUuid: string,
        role: ProjectMemberRole,
    ): Promise<void> {
        await this.database.raw<(DbProjectMembership & DbProject & DbUser)[]>(
            `
                UPDATE project_memberships AS m
                SET role = :role FROM projects AS p, users AS u
                WHERE p.project_id = m.project_id
                    AND u.user_id = m.user_id
                    AND user_uuid = :userUuid
                    AND p.project_uuid = :projectUuid
                    RETURNING *
            `,
            { projectUuid, userUuid, role },
        );
    }

    async deleteProjectAccess(
        projectUuid: string,
        userUuid: string,
    ): Promise<void> {
        await this.database.raw<(DbProjectMembership & DbProject & DbUser)[]>(
            `
            DELETE FROM project_memberships AS m
            USING projects AS p, users AS u
            WHERE p.project_id = m.project_id
              AND u.user_id = m.user_id
              AND user_uuid = :userUuid
              AND p.project_uuid = :projectUuid
        `,
            { projectUuid, userUuid },
        );
    }

    async findDbtCloudIntegration(
        projectUuid: string,
    ): Promise<DbtCloudIntegration | undefined> {
        const [row] = await this.database('dbt_cloud_integrations')
            .select(['metrics_job_id'])
            .innerJoin(
                'projects',
                'projects.project_id',
                'dbt_cloud_integrations.project_id',
            )
            .where('project_uuid', projectUuid);
        if (row === undefined) {
            return undefined;
        }
        return {
            metricsJobId: row.metrics_job_id,
        };
    }

    async findDbtCloudIntegrationWithSecrets(
        projectUuid: string,
    ): Promise<CreateDbtCloudIntegration | undefined> {
        const [row] = await this.database('dbt_cloud_integrations')
            .select(['metrics_job_id', 'service_token'])
            .innerJoin(
                'projects',
                'projects.project_id',
                'dbt_cloud_integrations.project_id',
            )
            .where('project_uuid', projectUuid);
        if (row === undefined) {
            return undefined;
        }
        const serviceToken = this.encryptionService.decrypt(row.service_token);
        return {
            metricsJobId: row.metrics_job_id,
            serviceToken,
        };
    }

    async upsertDbtCloudIntegration(
        projectUuid: string,
        integration: CreateDbtCloudIntegration,
    ): Promise<void> {
        const [project] = await this.database('projects')
            .select(['project_id'])
            .where('project_uuid', projectUuid);
        if (project === undefined) {
            throw new NotExistsError(
                `Cannot find project with id '${projectUuid}'`,
            );
        }
        const encryptedServiceToken = this.encryptionService.encrypt(
            integration.serviceToken,
        );
        await this.database('dbt_cloud_integrations')
            .insert({
                project_id: project.project_id,
                service_token: encryptedServiceToken,
                metrics_job_id: integration.metricsJobId,
            })
            .onConflict('project_id')
            .merge();
    }

    async deleteDbtCloudIntegration(projectUuid: string): Promise<void> {
        await this.database.raw(
            `
            DELETE FROM dbt_cloud_integrations AS i
            USING projects AS p
                   WHERE p.project_id = i.project_id
                   AND p.project_uuid = ?`,
            [projectUuid],
        );
    }

    async getWarehouseCredentialsForProject(
        projectUuid: string,
    ): Promise<CreateWarehouseCredentials> {
        const [row] = await this.database('warehouse_credentials')
            .innerJoin(
                'projects',
                'warehouse_credentials.project_id',
                'projects.project_id',
            )
            .select(['warehouse_type', 'encrypted_credentials'])
            .where('project_uuid', projectUuid);
        if (row === undefined) {
            throw new NotExistsError(
                `Cannot find any warehouse credentials for project.`,
            );
        }
        try {
            return JSON.parse(
                this.encryptionService.decrypt(row.encrypted_credentials),
            ) as CreateWarehouseCredentials;
        } catch (e) {
            throw new UnexpectedServerError(
                'Unexpected error: failed to parse warehouse credentials',
            );
        }
    }

    async duplicateContent(projectUuid: string, previewProjectUuid: string) {
        Logger.debug(
            `Duplicating content from ${projectUuid} to ${previewProjectUuid}`,
        );

        return this.database.transaction(async (trx) => {
            const [previewProject] = await trx('projects').where(
                'project_uuid',
                previewProjectUuid,
            );

            const [project] = await trx('projects')
                .where('project_uuid', projectUuid)
                .select('project_id');
            const projectId = project.project_id;

            const spaces = await trx('spaces').where('project_id', projectId);

            Logger.debug(
                `Duplicating ${spaces.length} spaces on ${previewProjectUuid}`,
            );
            const spaceIds = spaces.map((s) => s.space_id);

            const newSpaces =
                spaces.length > 0
                    ? await trx('spaces')
                          .insert(
                              spaces.map((d) => {
                                  const createSpace = {
                                      ...d,
                                      space_id: undefined,
                                      space_uuid: undefined,
                                      project_id: previewProject.project_id,
                                  };
                                  // Remove the keys for the autogenerated fields
                                  // Some databases do not support undefined values
                                  delete createSpace.space_id;
                                  delete createSpace.space_uuid;
                                  return createSpace;
                              }),
                          )
                          .returning('*')
                    : [];

            const spaceMapping = spaces.map((s, i) => ({
                id: s.space_id,
                newId: newSpaces[i].space_id,
            }));

            const getNewSpace = (oldSpaceId: number): number =>
                spaceMapping.find((s) => s.id === oldSpaceId)?.newId!;
            const spaceShares = await trx('space_share').whereIn(
                'space_id',
                spaceIds,
            );

            const newSpaceShare =
                spaceShares.length > 0
                    ? await trx('space_share')
                          .insert(
                              spaceShares.map((d) => ({
                                  ...d,
                                  space_id: getNewSpace(d.space_id),
                              })),
                          )
                          .returning('*')
                    : [];

            const charts = await trx('saved_queries')
                .leftJoin('spaces', 'saved_queries.space_id', 'spaces.space_id')
                .where('spaces.project_id', projectId)
                .select<DbSavedChart[]>('saved_queries.*');

            const chartIds = charts.map((d) => d.saved_query_id);
            Logger.debug(
                `Duplicating ${charts.length} charts on ${previewProjectUuid}`,
            );

            const newCharts =
                charts.length > 0
                    ? await trx('saved_queries')
                          .insert(
                              charts.map((d) => {
                                  const createChart = {
                                      ...d,
                                      saved_query_id: undefined,
                                      saved_query_uuid: undefined,
                                      space_id: getNewSpace(d.space_id),
                                  };
                                  delete createChart.saved_query_id;
                                  delete createChart.saved_query_uuid;
                                  return createChart;
                              }),
                          )
                          .returning('*')
                    : [];

            const chartMapping = charts.map((c, i) => ({
                id: c.saved_query_id,
                newId: newCharts[i].saved_query_id,
            }));

            // only get last chart version
            const lastVersionIds = await trx('saved_queries_versions')
                .whereIn('saved_query_id', chartIds)
                .groupBy('saved_query_id')
                .max('saved_queries_version_id');

            const chartVersions = await trx('saved_queries_versions')
                .whereIn(
                    'saved_queries_version_id',
                    lastVersionIds.map((d) => d.max),
                )
                .select('*');

            const chartVersionIds = chartVersions.map(
                (d) => d.saved_queries_version_id,
            );

            const newChartVersions =
                chartVersions.length > 0
                    ? await trx('saved_queries_versions')
                          .insert(
                              chartVersions.map((d) => {
                                  const createChartVersion = {
                                      ...d,
                                      saved_queries_version_id: undefined,
                                      saved_queries_version_uuid: undefined,
                                      saved_query_id: chartMapping.find(
                                          (m) => m.id === d.saved_query_id,
                                      )?.newId,
                                  };
                                  delete createChartVersion.saved_queries_version_id;
                                  delete createChartVersion.saved_queries_version_uuid;

                                  return createChartVersion;
                              }),
                          )
                          .returning('*')
                    : [];

            const chartVersionMapping = chartVersions.map((c, i) => ({
                id: c.saved_queries_version_id,
                newId: newChartVersions[i].saved_queries_version_id,
            }));

            const copyChartVersionContent = async (
                table: string,
                fieldId: string,
            ) => {
                const content = await trx(table)
                    .whereIn('saved_queries_version_id', chartVersionIds)
                    .select(`*`);

                if (content.length === 0) return undefined;

                const newContent = await trx(table)
                    .insert(
                        content.map((d) => {
                            const createContent = {
                                ...d,
                                saved_queries_version_id:
                                    chartVersionMapping.find(
                                        (m) =>
                                            m.id === d.saved_queries_version_id,
                                    )?.newId,
                            };
                            delete createContent[fieldId];
                            return createContent;
                        }),
                    )
                    .returning('*');

                return newContent;
            };

            await copyChartVersionContent(
                'saved_queries_version_table_calculations',
                'saved_queries_version_table_calculation_id',
            );
            await copyChartVersionContent(
                'saved_queries_version_sorts',
                'saved_queries_version_sort_id',
            );
            await copyChartVersionContent(
                'saved_queries_version_fields',
                'saved_queries_version_field_id',
            );
            await copyChartVersionContent(
                'saved_queries_version_additional_metrics',
                'saved_queries_version_additional_metric_id',
            );

            const dashboards = await trx('dashboards')
                .leftJoin('spaces', 'dashboards.space_id', 'spaces.space_id')
                .where('spaces.project_id', projectId)
                .select<DbDashboard[]>('dashboards.*');

            const dashboardIds = dashboards.map((d) => d.dashboard_id);

            Logger.debug(
                `Duplicating ${dashboards.length} dashboards on ${previewProjectUuid}`,
            );

            const newDashboards =
                dashboards.length > 0
                    ? await trx('dashboards')
                          .insert(
                              dashboards.map((d) => {
                                  const createDashboard = {
                                      ...d,
                                      dashboard_id: undefined,
                                      dashboard_uuid: undefined,
                                      space_id: getNewSpace(d.space_id),
                                  };
                                  delete createDashboard.dashboard_id;
                                  delete createDashboard.dashboard_uuid;
                                  return createDashboard;
                              }),
                          )
                          .returning('*')
                    : [];

            const dashboardMapping = dashboards.map((c, i) => ({
                id: c.dashboard_id,
                newId: newDashboards[i].dashboard_id,
            }));

            // Get last version of a dashboard
            const lastDashboardVersionsIds = await trx('dashboard_versions')
                .whereIn('dashboard_id', dashboardIds)
                .groupBy('dashboard_id')
                .max('dashboard_version_id');

            const dashboardVersionIds = lastDashboardVersionsIds.map(
                (d) => d.max,
            );

            const dashboardVersions = await trx('dashboard_versions')
                .whereIn('dashboard_version_id', dashboardVersionIds)
                .select('*');

            const newDashboardVersions =
                dashboardVersions.length > 0
                    ? await trx('dashboard_versions')
                          .insert(
                              dashboardVersions.map((d) => {
                                  const createDashboardVersion = {
                                      ...d,
                                      dashboard_version_id: undefined,
                                      dashboard_id: dashboardMapping.find(
                                          (m) => m.id === d.dashboard_id,
                                      )?.newId!,
                                  };
                                  delete createDashboardVersion.dashboard_version_id;
                                  return createDashboardVersion;
                              }),
                          )
                          .returning('*')
                    : [];

            const dashboardVersionsMapping = dashboardVersions.map((c, i) => ({
                id: c.dashboard_version_id,
                newId: newDashboardVersions[i].dashboard_version_id,
            }));

            const dashboardTiles = await trx('dashboard_tiles').whereIn(
                'dashboard_version_id',
                dashboardVersionIds,
            );

            Logger.debug(
                `Duplicating ${dashboardTiles.length} dashboard tiles on ${previewProjectUuid}`,
            );

            const dashboardTileUuids = dashboardTiles.map(
                (dv) => dv.dashboard_tile_uuid,
            );

            const newDashboardTiles =
                dashboardTiles.length > 0
                    ? await trx('dashboard_tiles')
                          .insert(
                              dashboardTiles.map((d) => ({
                                  ...d,
                                  // we keep the same dashboard_tile_uuid
                                  dashboard_version_id:
                                      dashboardVersionsMapping.find(
                                          (m) =>
                                              m.id === d.dashboard_version_id,
                                      )?.newId!,
                              })),
                          )
                          .returning('*')
                    : [];

            const dashboardTilesMapping = dashboardTiles.map((c, i) => ({
                id: c.dashboard_tile_uuid,
                newId: newDashboardTiles[i].dashboard_tile_uuid,
            }));

            const copyDashboardTileContent = async (table: string) => {
                const content = await trx(table)
                    .whereIn('dashboard_tile_uuid', dashboardTileUuids)
                    .and.whereIn('dashboard_version_id', dashboardVersionIds);

                if (content.length === 0) return undefined;

                const newContent = await trx(table).insert(
                    content.map((d) => ({
                        ...d,

                        // only applied to tile charts
                        ...(d.saved_chart_id && {
                            saved_chart_id: chartMapping.find(
                                (c) => c.id === d.saved_chart_id,
                            )?.newId,
                        }),

                        dashboard_version_id: dashboardVersionsMapping.find(
                            (m) => m.id === d.dashboard_version_id,
                        )?.newId!,
                        dashboard_tile_uuid: dashboardTilesMapping.find(
                            (m) => m.id === d.dashboard_tile_uuid,
                        )?.newId!,
                    })),
                );
                return newContent;
            };

            await copyDashboardTileContent('dashboard_tile_charts');
            await copyDashboardTileContent('dashboard_tile_looms');
            await copyDashboardTileContent('dashboard_tile_markdowns');

            const contentMapping: PreviewContentMapping = {
                charts: chartMapping,
                chartVersions: chartVersionMapping,
                spaces: spaceMapping,
                dashboards: dashboardMapping,
                dashboardVersions: dashboardVersionsMapping,
            };
            // Insert mapping on database
            await trx('preview_content').insert({
                project_uuid: projectUuid,
                preview_project_uuid: previewProjectUuid,
                content_mapping: contentMapping,
            });
        });
    }

    // Easier to mock in ProjectService
    // eslint-disable-next-line class-methods-use-this
    getWarehouseClientFromCredentials(credentials: CreateWarehouseCredentials) {
        return warehouseClientFromCredentials(credentials);
    }
}
