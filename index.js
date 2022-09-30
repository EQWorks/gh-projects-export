const { Octokit } = require('@octokit/core')
const { WebClient } = require('@slack/web-api')
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const isBetween = require('dayjs/plugin/isBetween')
dayjs.extend(utc)
dayjs.extend(isBetween)

const { GITHUB_TOKEN, GITHUB_ORG = 'EQWorks' } = process.env
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
  items.forEach(({ fieldValues, content }) => {
    // get the custom fields
    const meta = fieldValues.nodes
      .filter((n) => Object.keys(n).length > 0)
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
    const { title, repository: { name: track } = {}, number } = content
    if (!track) { // likely a draft issue
      return
    }
    data.push({
      number,
      track,
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

const slackCSV = ({ content, title, channels = process.env.SLACK_CHANNEL }) => {
  const client = new WebClient(process.env.SLACK_TOKEN)
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
