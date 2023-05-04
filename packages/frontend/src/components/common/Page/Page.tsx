import { Box, createStyles } from '@mantine/core';
import { FC } from 'react';
import { Helmet } from 'react-helmet';

import { TrackSection } from '../../../providers/TrackingProvider';
import { SectionName } from '../../../types/Events';
import AboutFooter, { FOOTER_HEIGHT, FOOTER_MARGIN } from '../../AboutFooter';
import { NAVBAR_HEIGHT } from '../../NavBar';
import { PAGE_HEADER_HEIGHT } from './PageHeader';
import Sidebar from './Sidebar';

type StyleProps = {
    withCenteredContent?: boolean;
    withFitContent?: boolean;
    withFixedContent?: boolean;
    withFooter?: boolean;
    withFullHeight?: boolean;
    withHeader?: boolean;
    withNavbar?: boolean;
    withPaddedContent?: boolean;
    withSidebar?: boolean;
    withSidebarFooter?: boolean;
};

export const PAGE_CONTENT_WIDTH = 900;
const PAGE_MIN_CONTENT_WIDTH = 600;

const usePageStyles = createStyles<string, StyleProps>((theme, params) => {
    let containerHeight = '100vh';

    if (params.withNavbar) {
        containerHeight = `calc(${containerHeight} - ${NAVBAR_HEIGHT}px)`;
    }
    if (params.withHeader) {
        containerHeight = `calc(${containerHeight} - ${PAGE_HEADER_HEIGHT}px)`;
    }

    return {
        root: {
            ...(params.withFullHeight
                ? {
                      height: containerHeight,
                      maxHeight: containerHeight,
                  }
                : {
                      height: containerHeight,

                      overflowY: 'auto',
                  }),

            ...(params.withSidebar
                ? {
                      display: 'flex',
                      flexDirection: 'row',
                  }
                : {}),
        },

        content: {
            paddingTop: theme.spacing.lg,
            paddingBottom: theme.spacing.lg,

            width: '100%',
            minWidth: PAGE_CONTENT_WIDTH,

            ...(params.withSidebar
                ? {
                      minWidth: PAGE_MIN_CONTENT_WIDTH,
                  }
                : {}),

            ...(params.withFooter
                ? {
                      minHeight: `calc(100% - ${FOOTER_HEIGHT}px - ${theme.spacing[FOOTER_MARGIN]} - 1px)`,
                  }
                : {}),

            ...(params.withFullHeight
                ? {
                      display: 'flex',
                      flexDirection: 'column',

                      height: '100%',
                      maxHeight: '100%',

                      overflowY: 'auto',
                  }
                : {}),

            ...(params.withFixedContent
                ? {
                      marginLeft: 'auto',
                      marginRight: 'auto',

                      width: PAGE_CONTENT_WIDTH,
                      flexShrink: 0,
                  }
                : {}),

            ...(params.withFitContent
                ? {
                      width: 'fit-content',
                      marginLeft: 'auto',
                      marginRight: 'auto',
                  }
                : {}),

            ...(params.withPaddedContent
                ? {
                      paddingLeft: theme.spacing.lg,
                      paddingRight: theme.spacing.lg,
                  }
                : {}),

            ...(params.withCenteredContent
                ? {
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                  }
                : {}),
        },
    };
});

type Props = {
    title?: string;
    sidebar?: React.ReactNode;
    isSidebarOpen?: boolean;
    header?: React.ReactNode;
} & Omit<StyleProps, 'withSidebar' | 'withHeader'>;

const Page: FC<Props> = ({
    title,
    header,
    sidebar,
    isSidebarOpen = true,

    withCenteredContent = false,
    withFitContent = false,
    withFixedContent = false,
    withFooter = false,
    withFullHeight = false,
    withNavbar = true,
    withPaddedContent = false,
    withSidebarFooter = false,

    children,
}) => {
    const { classes } = usePageStyles(
        {
            withCenteredContent,
            withFitContent,
            withFixedContent,
            withFooter,
            withFullHeight,
            withHeader: !!header,
            withNavbar,
            withPaddedContent,
            withSidebar: !!sidebar,
            withSidebarFooter,
        },
        { name: 'Page' },
    );

    return (
        <>
            {title ? (
                <Helmet>
                    <title>{title} - Lightdash</title>
                </Helmet>
            ) : null}

            {header}

            <Box className={classes.root}>
                {sidebar ? (
                    <Sidebar isOpen={isSidebarOpen}>
                        {sidebar}
                        {withSidebarFooter ? <AboutFooter minimal /> : null}
                    </Sidebar>
                ) : null}

                <Box className={classes.content}>
                    <TrackSection name={SectionName.PAGE_CONTENT}>
                        {children}
                    </TrackSection>
                </Box>

                {withFooter && !withSidebarFooter ? <AboutFooter /> : null}
            </Box>
        </>
    );
};

export default Page;
