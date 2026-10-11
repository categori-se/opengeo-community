"""Exercise publisher quota locks in disposable, networkless PostgreSQL.

Uses the already-cached pinned PostGIS image, never pulls or connects to AWS.
Minimal parent-table fixtures isolate quota concurrency; the full-schema tests
remain responsible for the source/job insertion contracts.
"""
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = 'docker.io/postgis/postgis@sha256:8828b03e9a95269f808abe62aa83215b22a2d3710f54a55e8040327b7b5f9932'


def main():
    name = 'opengeo-cache-concurrency-' + uuid.uuid4().hex[:12]
    receipt = {'network': 'none', 'image': IMAGE, 'fixture': 'minimal parent tables; exact migrations 0103/0104', 'removed': False}
    started = False
    processes = []

    def command(args, **kwargs):
        return subprocess.run(args, check=True, capture_output=True, text=True, timeout=45, **kwargs)

    def sql(value):
        return command(['podman', 'exec', '-i', name, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], input=value).stdout.strip()

    def background(value):
        proc = subprocess.Popen(['podman', 'exec', '-i', name, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(proc)
        proc.stdin.write(value)
        proc.stdin.close()
        proc.stdin = None
        return proc

    def wait_query(query):
        for _ in range(40):
            if sql(query) == 't':
                return
            time.sleep(.1)
        raise AssertionError('Expected concurrent database state was not observed')

    ids = [str(uuid.uuid4()) for _ in range(8)]
    org, project, source_a, source_b, revision, job_a, job_b, token = ids
    try:
        command(['podman', 'run', '--detach', '--pull=never', '--name', name, '--network=none',
                 '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--tmpfs', '/var/lib/postgresql/data', IMAGE])
        started = True
        for _ in range(60):
            ready = subprocess.run(['podman', 'exec', name, 'pg_isready', '-U', 'postgres'], capture_output=True, timeout=5)
            if ready.returncode == 0 and 'init process complete' in command(['podman','logs',name]).stdout:
                break
            time.sleep(.25)
        else:
            raise AssertionError('Local PostgreSQL did not become ready')
        sql('''CREATE SCHEMA app;
          CREATE ROLE opengeo_runtime; CREATE ROLE opengeo_worker; CREATE ROLE opengeo_connector;
          CREATE ROLE opengeo_observable_coordinator; CREATE ROLE opengeo_framework_publisher;
          GRANT USAGE ON SCHEMA app TO opengeo_observable_coordinator;
          CREATE TABLE app.organizations(id uuid PRIMARY KEY,status text);
          CREATE TABLE app.projects(id uuid PRIMARY KEY,organization_id uuid,status text);
          CREATE TABLE app.observable_source_projects(organization_id uuid,project_id uuid,id uuid,
            UNIQUE(organization_id,project_id,id));
          CREATE TABLE app.observable_source_revisions(id uuid,organization_id uuid,project_id uuid,
            source_project_id uuid,entry_path text);
          CREATE TABLE app.observable_build_jobs(id uuid PRIMARY KEY,organization_id uuid,project_id uuid,
            source_project_id uuid,source_revision_id uuid,coordinator_token uuid,state text,
            lease_expires_at timestamptz,request jsonb);''')
        sql((ROOT / 'database/migrations/0104_observable_cache_admission.sql').read_text())
        sql(f"""INSERT INTO app.organizations VALUES ('{org}','active');
          INSERT INTO app.projects VALUES ('{project}','{org}','active');
          INSERT INTO app.observable_cache_entitlements VALUES ('{org}',true,1);""")
        for source, job in [(source_a,job_a),(source_b,job_b)]:
            sql(f"""INSERT INTO app.observable_source_projects VALUES ('{org}','{project}','{source}');
              INSERT INTO app.observable_source_revisions VALUES ('{revision}','{org}','{project}','{source}','index.md');
              INSERT INTO app.observable_build_jobs VALUES ('{job}','{org}','{project}','{source}','{revision}',
                '{token}','running',now()+interval '15 minutes',
                '{{"compilerImageDigest":"sha256:{'a'*64}","frameworkVersion":"1.13.4"}}');""")
        def admit(job):
            return f"SELECT app.admit_observable_page_cache('{job}','{token}');"
        a = background("SET application_name='cache-quota-holder'; BEGIN; SET LOCAL ROLE opengeo_observable_coordinator; " + admit(job_a) + ' SELECT pg_sleep(4); COMMIT;')
        wait_query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='cache-quota-holder' AND wait_event='PgSleep');")
        b = background("SET application_name='cache-quota-contender'; SET ROLE opengeo_observable_coordinator; " + admit(job_b))
        wait_query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='cache-quota-contender' AND cardinality(pg_blocking_pids(pid))>0);")
        receipt['blockingObserved'] = True
        out_a, err_a = a.communicate(timeout=15)
        out_b, err_b = b.communicate(timeout=15)
        assert a.returncode == b.returncode == 0, (err_a,err_b)
        assert json.loads(out_a.strip())['sourceProjectId'] == source_a
        assert out_b.strip() == '', 'Second source exceeded one-slot quota'
        assert sql('SELECT count(*) FROM app.observable_cache_admissions;') == '1'
        assert json.loads(sql('SET ROLE opengeo_observable_coordinator; '+admit(job_a)))['sourceProjectId'] == source_a
        receipt['oneWinnerAndIdempotentRetry'] = True
        sql(f"UPDATE app.observable_build_jobs SET lease_expires_at=now()-interval '1 second' WHERE id='{job_a}';")
        assert sql('SET ROLE opengeo_observable_coordinator; '+admit(job_a)) == ''
        receipt['expiredLeaseDenied'] = True
        sql('''CREATE FUNCTION app.current_organization_id() RETURNS uuid LANGUAGE sql AS
            'SELECT current_setting(''app.organization_id'')::uuid';
          CREATE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql AS
            'SELECT current_setting(''app.user_id'')::uuid';
          CREATE TABLE app.organization_memberships(organization_id uuid,user_id uuid,role text);
          CREATE TABLE app.project_memberships(project_id uuid,user_id uuid,role text);
          CREATE FUNCTION app.effective_project_role(p_project uuid,p_user uuid) RETURNS text LANGUAGE sql AS
            'SELECT role FROM app.project_memberships WHERE project_id=p_project AND user_id=p_user';
          CREATE TABLE app.framework_publication_origins(id uuid PRIMARY KEY,organization_id uuid,
            hostname text,bucket text,distribution_id text,origin_id text,generation bigint DEFAULT 0,
            active_release_prefix text,enabled boolean,self_service_prefix text,active_publication_id uuid);
          CREATE TABLE app.framework_publication_mounts(id uuid PRIMARY KEY,organization_id uuid,
            project_id uuid,source_project_id uuid,origin_id uuid,mount_path text,enabled boolean,
            verified_by uuid,verified_at timestamptz);''')
        reviews = (ROOT / 'database/migrations/0092_framework_publication_reviews.sql').read_text()
        authority = reviews.split('CREATE FUNCTION app.require_framework_publication_authority',1)[1].split('CREATE FUNCTION app.review_framework_publication',1)[0]
        sql('CREATE FUNCTION app.require_framework_publication_authority'+authority)
        sql((ROOT / 'database/migrations/0103_delegated_publication_addresses.sql').read_text())
        sql('CREATE TRIGGER origin_guard BEFORE UPDATE ON app.framework_publication_origins FOR EACH ROW EXECUTE FUNCTION app.guard_framework_publication_origin();')
        user, origin, mount_a, mount_b = [str(uuid.uuid4()) for _ in range(4)]
        sql(f"""INSERT INTO app.organization_memberships VALUES ('{org}','{user}','member');
          INSERT INTO app.project_memberships VALUES ('{project}','{user}','owner');
          INSERT INTO app.framework_publication_origins
            (id,organization_id,hostname,enabled,self_service_prefix,project_reservation_limit)
            VALUES ('{origin}','{org}','public.example.test',true,'/publications/',1);""")
        context = f"SET app.organization_id='{org}'; SET app.user_id='{user}'; SET ROLE opengeo_runtime; "
        def reserve(mount, source, slug):
            return f"SELECT app.reserve_framework_publication_mount('{mount}','{project}','{source}','{origin}','{slug}','reserve-address-without-publishing');"
        sql('GRANT USAGE ON SCHEMA app TO opengeo_runtime;')
        a = background("SET application_name='address-quota-holder'; BEGIN; " + context + reserve(mount_a,source_a,'alpha')+' SELECT pg_sleep(4); COMMIT;')
        wait_query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='address-quota-holder' AND wait_event='PgSleep');")
        b = background("SET application_name='address-quota-contender'; " + context + reserve(mount_b,source_b,'bravo'))
        wait_query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='address-quota-contender' AND cardinality(pg_blocking_pids(pid))>0);")
        out_a, err_a = a.communicate(timeout=15)
        out_b, err_b = b.communicate(timeout=15)
        assert a.returncode == 0 and out_a.strip() == mount_a, err_a
        assert b.returncode != 0 and 'capacity reached' in err_b
        assert sql('SELECT count(*) FROM app.framework_publication_mounts;') == '1'
        assert sql(context + reserve(mount_a,source_a,'alpha')) == mount_a
        receipt['addressBlockingObserved'] = True
        receipt['addressOneWinnerAndIdempotentRetry'] = True
        receipt['status'] = 'passed'
    finally:
        for proc in processes:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=10)
        if started:
            command(['podman','rm','--force','--volumes',name])
            receipt['removed'] = True
        print(json.dumps(receipt))


if __name__ == '__main__':
    main()
