const { Octokit } = require('@octokit/core')
const { WebClient } = require('@slack/web-api')
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const isBetween = require('dayjs/plugin/isBetween')
dayjs.extend(utc)
dayjs.extend(isBetween)

const { GITHUB_TOKEN, GITHUB_ORG = 'EQWorks', SLACK_CHANNEL, SLACK_TOKEN } = process.env
const octokit = new Octokit({ auth: GITHUB_TOKEN })

const getProjectID = ({ login = GITHUB_ORG, number = 16 } = {}) => octokit.graphql(
  `
    query project($login: String!, $number: Int!) {
      organization(login: $login) {
        projectV2(number: $number) {
          id
        }
      }
    }
  `,
  {
    login,
    number,
  },
)

const getProjectItems = async (id) => {
  let data = []
  let hasNextPage = true
  let endCursor = null
  while (hasNextPage) {
    const { node: { items: { pageInfo = {}, nodes = [] } = {} } = {} } = await octokit.graphql(
      `
        query($id: ID!, $after: String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(
                first: 100
                orderBy: {direction: DESC, field: POSITION}
                after: $after
              ) {
                pageInfo {
                  endCursor
                  hasNextPage
                }
                nodes {
                  fieldValues(first: 20) {
                    nodes {
                      ... on ProjectV2ItemFieldIterationValue {
                        title
                        startDate
                        field {
                          ... on ProjectV2IterationField {
                            name
                          }
                        }
                      }
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field {
                          ... on ProjectV2SingleSelectField {
                            name
                          }
                        }
                      }
                      ... on ProjectV2ItemFieldPullRequestValue {
                        pullRequests(first: 10) {
                          nodes {
                            id
                          }
                        }
                      }
                    }
                  }
                  content{
                    ...on Issue {
                      title
                      state
                      number
                      repository {
                        name
                      }
                    }
                    ...on PullRequest {
                      id
                      title
                      state
                      number
                      repository {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        id,
        after: endCursor,
      },
    )
    data = data.concat(nodes)
    hasNextPage = pageInfo.hasNextPage
    endCursor = pageInfo.endCursor
  }
  return data
}

const filterItems = (items) => {
  const data = []
  // build list of issue-linked PRs
  const linkedPRs = items.reduce((acc, { fieldValues }) => {
    const prs = fieldValues.nodes.find((n) => n.pullRequests)?.pullRequests.nodes.map(({ id }) => id) || []
    return Array.from(new Set([...acc, ...prs]))
  }, [])
  items.forEach(({ fieldValues, content }) => {
    // get the custom fields
    const meta = fieldValues.nodes
      .filter((n) => Object.keys(n).length > 0 && !n.pullRequests)
      .reduce((acc, { name: value, field: { name }, ...rest }) => {
        acc[name] = { value, ...rest }
        return acc
      }, {})
    // skip the done ones
    if (meta.Status.value.toLowerCase().endsWith('done')) {
      return
    }
    // skip the ones without an iteration
    if (!meta.Iteration) {
      return
    }
    // skip the ones that are after the current iteration
    const start = dayjs.utc(meta.Iteration.startDate)
    if (dayjs.utc().isBefore(start)) {
      return
    }
    // parse content
    const { title, repository: { name: track } = {}, number, id } = content
    // skip draft issues (without a repository)
    if (!track) {
      return
    }
    // skip the PRs that have an associated issue
    if (id && linkedPRs.includes(id)) {
      return
    }
    data.push({
      track,
      number,
      title,
    })
  })
  return data
}

const toCSV = (data) => {
  if (!data.length) {
    return ''
  }
  const headers = Object.keys(data[0])
  let csv = headers.map((h) => `"${h}"`).join(',') + '\n'
  data.forEach((r) => {
    csv += headers.map((h) => `"${r[h]}"`).join(',') + '\n'
  })
  return csv.trim()
}

const slackCSV = ({ content, title, channels = SLACK_CHANNEL }) => {
  const client = new WebClient(SLACK_TOKEN)
  return client.files.upload({
    channels,
    title,
    filename: `${title}.csv`,
    content,
    filetype: 'csv',
  })
}

;(async () => {
  const id = (await getProjectID())?.organization?.projectV2?.id
  const items = await(getProjectItems(id))
  const data = filterItems(items)
  const content = toCSV(data)
  await slackCSV({ content, title: `auto-insights-${new Date().toISOString().split('T')[0]}` })
})()
