// Minutes CI/CD. Source -> Harbor -> minutes-deploy -> ArgoCD -> Kubernetes.
//
// This pipeline never talks to Kubernetes. Its last act is a commit to
// minutes-deploy; ArgoCD is what applies it. That separation is the whole point
// of the deploy repository - the cluster's desired state is a file in git, not
// a side effect of a build job.
//
// The agent needs nothing installed but Docker and git: every test runs inside
// an image built from this repository's own Dockerfile (`--target web-test`,
// `--target backend-test`), against the same dependency layers the pushed image
// is made of.
//
// Nothing about a run is selectable, and that is the point. A push to main runs
// the whole thing - test, build, push, newTag - with nothing for a person to
// choose,
// so what ArgoCD syncs is decided by the commit and never by how the job was
// started. A run that must not reach minutes-deploy is a run that should not
// have been started.
pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
        timeout(time: 60, unit: 'MINUTES')
    }

    triggers {
        // Polling, not a cron build: Jenkins asks git every ~3 minutes whether the
        // tip of the branch moved and starts a build only when it did. `H/3`
        // rather than `*/3` so the controller spreads this job's poll across the
        // interval instead of stacking every job on the same tick.
        //
        // Polling and not a webhook because this Jenkins is on the NCP private
        // interface with nothing for GitHub to reach. A webhook would be the
        // better trigger the day there is an ingress for it.
        pollSCM('H/3 * * * *')
    }

    environment {
        // Harbor. HTTP only, on the NCP private interface; the Docker daemon on
        // this host already has it in insecure-registries.
        HARBOR_REGISTRY = '10.0.1.7:8082'
        HARBOR_PROJECT  = 'minutes'
        IMAGE_NAME      = 'minutes'
        IMAGE_REPO      = "${HARBOR_REGISTRY}/${HARBOR_PROJECT}/${IMAGE_NAME}"

        DEPLOY_REPO_URL  = 'github.com/gwanghun-choi/minutes-deploy.git'
        DEPLOY_BRANCH    = 'main'
        DEPLOY_OVERLAY   = 'environments/dev'
        DEPLOY_WORKSPACE = 'minutes-deploy'

        // The CI database. pgvector, because migration 001 is
        // `CREATE EXTENSION vector`. Keep the major version aligned with the
        // PostgreSQL the deployment actually runs.
        CI_POSTGRES_IMAGE = 'pgvector/pgvector:pg16'
        CI_DB_PASSWORD    = 'ci-throwaway'   // a container that lives for one stage

        // The floor the backend suite must clear. Raise it when tests are added;
        // it exists so a suite that quietly stops collecting cannot pass.
        MIN_BACKEND_TESTS = '437'

        DOCKER_BUILDKIT = '1'
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
                script {
                    // The immutable half of the tag pair. Read from the tree
                    // Jenkins actually checked out, not from a webhook payload.
                    env.GIT_SHA  = sh(returnStdout: true, script: 'git rev-parse --short=7 HEAD').trim()
                    env.SHA_TAG  = "sha-${env.GIT_SHA}"
                    env.CI_NET   = "minutes-ci-${env.BUILD_NUMBER}"
                    env.CI_DB    = "minutes-ci-db-${env.BUILD_NUMBER}"
                    env.TEST_IMG = "minutes-backend-test:${env.SHA_TAG}"
                    currentBuild.displayName = "#${env.BUILD_NUMBER} ${env.SHA_TAG}"
                }
                sh 'echo "building ${IMAGE_REPO}:${SHA_TAG}"'
            }
        }

        stage('Frontend Test') {
            // typecheck is inside `npm run build`, which the web stage already
            // runs, so a type error fails before this stage is even reached.
            // What is added here is eslint and Vitest.
            //
            // Not the Playwright smoke: it needs a Chromium build and ~40 apt
            // packages in the node image and re-runs `npm run build`, which is a
            // large network-bound layer on a 4 vCPU host for a bundle this build
            // just made. It stays a local and Human UAT gate - see README.
            steps {
                sh '''
                    set -eu
                    docker build --target web-test -t minutes-web-test:${SHA_TAG} .
                '''
            }
        }

        stage('Backend Test') {
            // The suite skips every DB-backed test when PostgreSQL is
            // unreachable - 42 of 437 run, and the build goes green having
            // proved almost nothing. So a throwaway database is stood up for
            // the run and destroyed with it. The schema is created by the
            // application's own migration runner (tests/conftest.py calls it),
            // which means every build also exercises migrations 001..011 on a
            // genuinely empty database.
            steps {
                sh '''
                    set -eu
                    docker build --target backend-test -t ${TEST_IMG} .

                    docker network create ${CI_NET}
                    docker run -d --name ${CI_DB} --network ${CI_NET} \
                        -e POSTGRES_PASSWORD=${CI_DB_PASSWORD} \
                        -e POSTGRES_DB=minutes \
                        ${CI_POSTGRES_IMAGE}

                    echo "waiting for the CI database"
                    for i in $(seq 1 60); do
                        if docker exec ${CI_DB} pg_isready -U postgres -d minutes >/dev/null 2>&1; then
                            echo "database ready after ${i}s"; break
                        fi
                        [ "${i}" = "60" ] && { docker logs ${CI_DB}; echo "database never came up"; exit 1; }
                        sleep 1
                    done

                    # No pipe into tee: this is /bin/sh, there is no pipefail
                    # here, and a pipeline would report tee's exit code and turn
                    # a failing suite into a green build.
                    set +e
                    docker run --rm --network ${CI_NET} \
                        -e DATABASE_HOST=${CI_DB} \
                        -e DATABASE_PORT=5432 \
                        -e DATABASE_NAME=minutes \
                        -e DATABASE_SCHEMA=minutes \
                        -e DATABASE_USER=postgres \
                        -e DATABASE_PASSWORD=${CI_DB_PASSWORD} \
                        ${TEST_IMG} \
                        python -m pytest tests -q --no-header -p no:cacheprovider \
                        > backend-test.log 2>&1
                    RC=$?
                    set -e
                    cat backend-test.log
                    [ "${RC}" = "0" ] || { echo "FAIL: pytest exited ${RC}"; exit 1; }

                    # Green is not enough. This suite has exactly two skip
                    # conditions - no database, and no frontend/dist - and the
                    # backend-test image satisfies both, so a skip here means the
                    # database connection quietly failed and the run proved
                    # nothing. Without one, 395 of 437 tests skip and pytest
                    # still exits 0.
                    if grep -qE '[0-9]+ skipped' backend-test.log; then
                        echo "FAIL: tests were skipped - see above; the CI database or the bundle was missing"
                        exit 1
                    fi

                    # And the count must not shrink. A refactor that silently
                    # stops collecting a module passes every other check.
                    PASSED=$(grep -oE '^[0-9]+ passed' backend-test.log | tail -1 | cut -d' ' -f1)
                    echo "backend tests passed: ${PASSED} (floor ${MIN_BACKEND_TESTS})"
                    [ -n "${PASSED}" ] || { echo "FAIL: could not read the pytest summary"; exit 1; }
                    [ "${PASSED}" -ge "${MIN_BACKEND_TESTS}" ] \
                        || { echo "FAIL: ${PASSED} < ${MIN_BACKEND_TESTS} - tests disappeared"; exit 1; }
                '''
            }
            post {
                always {
                    sh '''
                        docker rm -f ${CI_DB} >/dev/null 2>&1 || true
                        docker network rm ${CI_NET} >/dev/null 2>&1 || true
                    '''
                }
            }
        }


        stage('Docker Build') {
            // One build, one image, one digest. `--target app` is explicit even
            // though app is the last stage, so adding a stage below it can never
            // silently change what gets pushed.
            steps {
                sh '''
                    set -eu
                    docker build --target app -t ${IMAGE_REPO}:${SHA_TAG} .
                    # The mutable tag is applied to the image that was just
                    # built, never rebuilt. `dev` and sha-xxxxxxx are two names
                    # for one digest.
                    docker tag ${IMAGE_REPO}:${SHA_TAG} ${IMAGE_REPO}:dev
                '''
            }
        }

        stage('Harbor Login') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'minutes-harbor-push',
                    usernameVariable: 'HARBOR_USER',
                    passwordVariable: 'HARBOR_PASS'
                )]) {
                    sh '''
                        set -eu
                        echo "${HARBOR_PASS}" | docker login ${HARBOR_REGISTRY} \
                            -u "${HARBOR_USER}" --password-stdin
                    '''
                }
            }
        }

        stage('Harbor Push') {
            steps {
                sh '''
                    set -eu
                    docker push ${IMAGE_REPO}:${SHA_TAG}
                    docker push ${IMAGE_REPO}:dev
                    echo "pushed digest:"
                    docker image inspect ${IMAGE_REPO}:${SHA_TAG} \
                        --format '{{index .RepoDigests 0}}' || true
                '''
            }
        }

        stage('Deploy Repo Checkout') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'minutes-github',
                    usernameVariable: 'GH_USER',
                    passwordVariable: 'GH_TOKEN'
                )]) {
                    sh '''
                        set -eu
                        rm -rf ${DEPLOY_WORKSPACE}
                        # A shallow clone of one branch: this job only ever adds
                        # one commit on top of the tip.
                        git clone --depth 1 --branch ${DEPLOY_BRANCH} \
                            "https://${GH_USER}:${GH_TOKEN}@${DEPLOY_REPO_URL}" ${DEPLOY_WORKSPACE}
                    '''
                }
            }
        }

        stage('Update newTag') {
            // The single line of desired state this pipeline owns. Everything
            // else in minutes-deploy is edited by a person.
            steps {
                sh '''
                    set -eu
                    KFILE="${DEPLOY_WORKSPACE}/${DEPLOY_OVERLAY}/kustomization.yaml"
                    test -f "${KFILE}" || { echo "missing ${KFILE}"; exit 1; }

                    # Refuse to edit a file whose shape is not what this job
                    # expects. A silent no-op sed that still commits nothing is
                    # worse than a failed build: ArgoCD would keep serving the
                    # previous image while the pipeline reported success.
                    grep -q "name: ${IMAGE_REPO}$" "${KFILE}" \
                        || { echo "image ${IMAGE_REPO} not found in ${KFILE}"; exit 1; }
                    [ "$(grep -c '^[[:space:]]*newTag:' "${KFILE}")" = "1" ] \
                        || { echo "expected exactly one newTag: line in ${KFILE}"; exit 1; }

                    # awk, not a sed backreference: backslash-digit is not a legal
                    # escape inside a Groovy triple-quoted string and never
                    # reaches sed intact. `sub` on the matched line keeps the
                    # original indentation without needing a capture group.
                    awk -v tag="${SHA_TAG}" \
                        '$1 == "newTag:" { sub(/newTag:.*/, "newTag: " tag) } { print }' \
                        "${KFILE}" > "${KFILE}.tmp"
                    mv "${KFILE}.tmp" "${KFILE}"

                    grep -q "newTag: ${SHA_TAG}$" "${KFILE}" \
                        || { echo "newTag was not updated to ${SHA_TAG}"; exit 1; }
                    echo "--- ${DEPLOY_OVERLAY}/kustomization.yaml ---"
                    cat "${KFILE}"
                '''
            }
        }

        stage('Deploy Repo Commit & Push') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'minutes-github',
                    usernameVariable: 'GH_USER',
                    passwordVariable: 'GH_TOKEN'
                )]) {
                    sh '''
                        set -eu
                        cd ${DEPLOY_WORKSPACE}
                        git config user.email "jenkins@minutes.local"
                        git config user.name  "minutes-ci"

                        # A rebuild of the same commit produces the same tag, so
                        # there is nothing to say. Committing an empty change
                        # would churn ArgoCD for no reason.
                        if git diff --quiet; then
                            echo "newTag already ${SHA_TAG} - nothing to commit"
                            exit 0
                        fi

                        git add ${DEPLOY_OVERLAY}/kustomization.yaml
                        git commit -m "deploy(dev): minutes ${SHA_TAG}" \
                                   -m "source: ${GIT_URL:-minutes}@${GIT_SHA}" \
                                   -m "jenkins build #${BUILD_NUMBER}"
                        git push "https://${GH_USER}:${GH_TOKEN}@${DEPLOY_REPO_URL}" HEAD:${DEPLOY_BRANCH}
                        echo "pushed - ArgoCD will sync ${DEPLOY_OVERLAY}"
                    '''
                }
            }
        }
    }

    post {
        always {
            // The credential lives in ~/.docker/config.json until it is removed.
            sh 'docker logout ${HARBOR_REGISTRY} >/dev/null 2>&1 || true'
            // Keep the disk on a 4 vCPU / 15 GiB host from filling with tagged
            // layers. The pushed image stays in Harbor; the local tags do not
            // need to.
            sh '''
                docker rmi ${TEST_IMG} minutes-web-test:${SHA_TAG} >/dev/null 2>&1 || true
                docker image prune -f >/dev/null 2>&1 || true
            '''
            // deleteDir(), not cleanWs(): the Workspace Cleanup plugin is not
            // installed on this controller and cleanWs() fails the post block.
            // deleteDir() is core Pipeline and needs no plugin.
            deleteDir()
        }
        success {
            echo "OK  ${IMAGE_REPO}:${SHA_TAG} (also :dev)"
        }
    }
}
